/// CLIENT-IN-THE-LOOP e2e: opto_sync_client against the live node+Postgres server.
///
/// What makes these different from the package's own unit tests: the real Drift
/// mutation queue and the real FfiSyncer reconcile path are driven against a REAL
/// server that merges with the same syncer.c core, over HTTP, with the document
/// round-tripping through Postgres jsonb. The package ships no transport, so the
/// transport lives in support.dart — the package's queue lifecycle
/// (pending -> synced/failed) and its reconcile output are what is under test.
///
/// Scenario numbering and every fixture value are shared verbatim with the
/// TypeScript and Rust suites via ../fixtures/*.json.
import 'dart:convert';

import 'package:opto_sync_client/opto_sync_client.dart';
import 'package:opto_sync_client_e2e/support.dart';
import 'package:test/test.dart';

class _LiveProtocolTransport implements ProtocolTransport {
  Map<String, dynamic> _body(HttpResult response, String operation) {
    final body = response.json;
    if (body is! Map) {
      throw SyncTransportException(
        '$operation returned a non-object response',
        retryable: false,
      );
    }
    return Map<String, dynamic>.from(body);
  }

  Never _failure(HttpResult response, String operation) {
    final body = _body(response, operation);
    throw SyncTransportException(
      '${body['message'] ?? '$operation failed with HTTP ${response.status}'}',
      retryable: response.status >= 500 || response.status == 429,
    );
  }

  @override
  Future<Map<String, dynamic>> push(
    Map<String, dynamic> request,
    ProtocolCancellationToken cancellation,
  ) async {
    cancellation.throwIfCancelled();
    final response = await protocolPush(request);
    cancellation.throwIfCancelled();
    if (!response.ok) _failure(response, 'push');
    return _body(response, 'push');
  }

  @override
  Future<Map<String, dynamic>> pull(
    String checkpoint,
    int limit,
    ProtocolCancellationToken cancellation,
  ) async {
    cancellation.throwIfCancelled();
    final response = await protocolPull(checkpoint, limit: limit);
    cancellation.throwIfCancelled();
    if (response.status == 409 &&
        response.json is Map &&
        (response.json as Map)['error'] == 'RESET_REQUIRED') {
      return Map<String, dynamic>.from(response.json as Map);
    }
    if (!response.ok) _failure(response, 'pull');
    return _body(response, 'pull');
  }

  @override
  Future<Map<String, dynamic>> snapshot(
    ProtocolCancellationToken cancellation, [
    Map<String, dynamic>? reset,
  ]) async {
    cancellation.throwIfCancelled();
    final response = await protocolSnapshot();
    cancellation.throwIfCancelled();
    if (!response.ok) _failure(response, 'snapshot');
    return _body(response, 'snapshot');
  }
}

class _MemoryProtocolCallbacks implements ProtocolSyncCallbacks {
  final Map<String, Map<String, dynamic>> records = {};

  @override
  Future<void> applyChanges(List<Map<String, dynamic>> changes) async {
    for (final change in changes) {
      final id = change['recordId'] as String;
      if (change['operation'] == 'delete') {
        records.remove(id);
      } else {
        records[id] = Map<String, dynamic>.from(change['record'] as Map);
      }
    }
  }

  @override
  Future<void> replaceAuthoritative(List<Map<String, dynamic>> snapshot) async {
    records.clear();
    for (final entry in snapshot) {
      records[entry['recordId'] as String] = Map<String, dynamic>.from(
        entry['record'] as Map,
      );
    }
  }
}

Future<void> main() async {
  // Probe ONCE, up front, so the whole group is skipped with one clear reason
  // rather than hanging on a dead socket.
  final skipReason = await probeServer();
  if (skipReason != null) {
    // ignore: avoid_print
    print('\n[dart] SKIPPING client-in-the-loop e2e — $skipReason\n');
  }

  late FfiSyncer syncer;
  final open = <OptoSyncClient>[];

  OptoSyncClient freshClient() {
    final c = newClient(syncer);
    open.add(c);
    return c;
  }

  /// Flush one queued mutation through the real client lifecycle: read it back
  /// out of the queue, push it, then mark it synced or failed according to what
  /// the server actually said.
  Future<HttpResult> flushOne(
    OptoSyncClient client,
    Mutation mutation,
    String id,
  ) async {
    final res = await syncDoc(
      id,
      jsonDecode(mutation.jsonPayload) as Map<String, dynamic>,
    );
    await markMutation(
      client,
      mutation.id,
      res.ok ? SyncStatus.synced : SyncStatus.failed,
    );
    return res;
  }

  Map<String, dynamic> expectedWithQueuedStamp(
    Object? expected,
    Mutation mutation,
  ) {
    final payload = jsonDecode(mutation.jsonPayload) as Map<String, dynamic>;
    final stamp = payload['updatedAt'];
    expect(stamp, isA<String>());
    expect(
      parseHlc(stamp as String),
      isNotNull,
      reason: 'queued updatedAt must be a valid HLC',
    );
    return {...(expected as Map<String, dynamic>), 'updatedAt': stamp};
  }

  group(
    'opto_sync_client client-in-the-loop e2e',
    () {
      setUpAll(() {
        syncer = newSyncer();
      });

      tearDown(() async {
        for (final c in open) {
          await c.db.close();
        }
        open.clear();
      });

      test('0. the Dart client defaults to the SERVER\'s merge policy', () {
        // This asserts the default, because every other test here relies on it
        // (no options are passed anywhere). It is the same policy the TypeScript
        // and Rust clients and every opto-sync server use.
        final s = newSyncer();
        expect(s.arrayStrategy, ArrayMergeStrategy.mergeByKey);
        expect(s.arrayMatchKeys, 'id');
        expect(s.resolveByTimestamp, isTrue);
        expect(s.lwwKeys, 'updatedAt,syncedAt');
        // No FWW key. FWW in the core is a node-level VETO — an incoming node
        // whose FWW key is newer is dropped WHOLESALE, however new its updatedAt
        // is — so a default `createdAt` let a replica holding a later createdAt
        // lock a record forever. Callers opt in per merge instead.
        expect(s.fwwKeys, anyOf(isNull, isEmpty));
        expect(s.nativeVersion, matches(RegExp(r'^\d+\.\d+\.\d+$')));
      });

      /* ================================================================ */
      /* Scenario 1 — offline queue -> flush -> server merge              */
      /* ================================================================ */

      test('1a. offline queue flushed one-by-one: all synced, server has every '
          'contribution', () async {
        final fx = scenario('offlineQueue');
        final id = docId(fx['docSuffixIndividual'] as String);
        await putDoc(id, fx['base']!);

        final client = freshClient();
        final mutations = arr(fx, 'mutations');

        // "Offline": queue everything, send nothing.
        for (final m in mutations) {
          await client.queueMutation('docs', id, m as Map<String, dynamic>);
        }

        expect(
          (await pendingMutations(client)).length,
          mutations.length,
          reason: 'all mutations must be queued as pending',
        );
        expect(
          await statusCounts(client),
          const StatusCounts(3, 3, 0, 0),
          reason: 'nothing may be marked synced before a flush',
        );
        expect(
          (await getDocData(id))['m1'],
          isNull,
          reason: 'server must be untouched while offline',
        );

        // Back online: flush in queue order.
        final pending = await pendingMutations(client);
        final expected = expectedWithQueuedStamp(fx['expected'], pending.last);
        for (final m in pending) {
          final res = await flushOne(client, m, id);
          expect(
            res.status,
            200,
            reason: 'sync of mutation ${m.id}: ${res.body}',
          );
          expect((res.json as Map)['merged'], isTrue);
          expect(
            (res.json as Map)['mergedWith'],
            'native-c-ffi',
            reason: 'the server must merge with the C core',
          );
        }

        expect(
          await pendingMutations(client),
          isEmpty,
          reason: 'queue must be drained',
        );
        expect(await statusCounts(client), const StatusCounts(3, 0, 3, 0));

        expectDeepEqual(
          await getDocData(id),
          expected,
          'server document after individual flush',
        );
      });

      test(
        '1b. offline queue flushed atomically via /sync/batch: same result',
        () async {
          final fx = scenario('offlineQueue');
          final id = docId(fx['docSuffixBatch'] as String);
          await putDoc(id, fx['base']!);

          final client = freshClient();
          for (final m in arr(fx, 'mutations')) {
            await client.queueMutation('docs', id, m as Map<String, dynamic>);
          }

          final pending = await pendingMutations(client);
          expect(pending.length, 3);
          final expected = expectedWithQueuedStamp(
            fx['expected'],
            pending.last,
          );

          final result = await syncBatch([
            for (final m in pending)
              {'docId': id, 'payload': jsonDecode(m.jsonPayload)},
          ]);
          expect(
            result['applied'],
            3,
            reason: 'all three mutations must apply: $result',
          );

          for (final m in pending) {
            await markMutation(client, m.id, SyncStatus.synced);
          }
          expect(await statusCounts(client), const StatusCounts(3, 0, 3, 0));

          expectDeepEqual(
            await getDocData(id),
            expected,
            'server document after batch flush',
          );
        },
      );

      /* ================================================================ */
      /* Scenario 2 — optimistic local write, then pull-back reconcile    */
      /* ================================================================ */

      test(
        '2. optimistic local write then server pull-back reconcile converges',
        () async {
          final fx = scenario('optimisticPullback');
          final id = docId(fx['docSuffix'] as String);
          await putDoc(id, fx['base']!);

          final client = freshClient();

          // Optimistic: apply the mutation to the local copy through the client's
          // own reconcile path (NOT a hand-rolled map merge) before any network I/O.
          final localAfterOptimistic = await client.reconcileIncoming(
            'docs',
            id,
            obj(fx, 'mutation'),
            obj(fx, 'base'),
          );
          expectDeepEqual(
            localAfterOptimistic,
            fx['expected'],
            'local copy after optimistic apply',
          );

          // Push, then pull the server's own view back.
          await client.queueMutation('docs', id, obj(fx, 'mutation'));
          final queued = (await pendingMutations(client)).single;
          final expected = expectedWithQueuedStamp(fx['expected'], queued);
          final res = await flushOne(client, queued, id);
          expect(res.status, 200, reason: res.body);

          final serverData = await getDocData(id);
          expectDeepEqual(serverData, expected, 'server document after push');

          // Reconcile the pulled server state back into the local copy.
          final localAfterPullback = await client.reconcileIncoming(
            'docs',
            id,
            serverData,
            localAfterOptimistic,
          );
          expectDeepEqual(
            localAfterPullback,
            serverData,
            'local copy after pull-back vs server',
          );
          expectDeepEqual(
            localAfterPullback,
            expected,
            'local copy after pull-back vs expectation',
          );

          // The stored jsonb text is NOT the string we sent — proof that comparing
          // raw strings would be wrong, and that we never do.
          expectDeepEqual(
            jsonDecode(await getDocRaw(id)),
            expected,
            'raw jsonb text parses to the same value',
          );
        },
      );

      test(
        '2b. ProtocolSyncLoop drives Drift queue through live PostgreSQL',
        () async {
          final id =
              '${docId('sync-loop')}-${DateTime.now().microsecondsSinceEpoch}';
          final client = freshClient();
          await client.queueMutation('docs', id, {
            'title': 'scheduled Dart write',
            'nested': {'value': 7},
          }, baseRevision: '0');
          final queued = (await client.pendingMutations()).single;
          final queuedPayload =
              jsonDecode(queued.jsonPayload) as Map<String, dynamic>;
          final callbacks = _MemoryProtocolCallbacks();
          final loop = ProtocolSyncLoop(
            client,
            _LiveProtocolTransport(),
            callbacks,
          );

          final result = await loop.syncNow();
          expect(result.pushedMutations, 1);
          expect(result.acknowledgedMutations, 1);
          expect(result.hasMorePending, isFalse);
          expect(await client.pendingMutations(), isEmpty);
          expectDeepEqual(
            callbacks.records[id],
            queuedPayload,
            'Dart checkpointed pull must contain the server echo',
          );
          expect(await client.pullCheckpoint(), isNot('0'));
        },
      );

      /* ================================================================ */
      /* Scenario 3 — stale-write rejection round-trip, both directions   */
      /* ================================================================ */

      test(
        '3. stale server state loses to newer local; fresher server state wins',
        () async {
          final fx = scenario('staleRejection');
          final id = docId(fx['docSuffix'] as String);
          final client = freshClient();

          // Server holds an OLDER state than the local copy.
          await putDoc(id, fx['serverStale']!);
          final stale = await getDocData(id);
          expectDeepEqual(
            stale,
            fx['serverStale'],
            'server precondition (stale)',
          );

          final survived = await client.reconcileIncoming(
            'docs',
            id,
            stale,
            obj(fx, 'local'),
          );
          expectDeepEqual(
            survived,
            fx['expectedLocalSurvives'],
            'local value must survive a stale server pull',
          );
          expect(
            survived['sOnly'],
            isNull,
            reason:
                'whole-object rejection: no key from the stale doc may leak in',
          );

          // Now the server holds a NEWER state.
          await putDoc(id, fx['serverFresh']!);
          final fresh = await getDocData(id);
          final overwritten = await client.reconcileIncoming(
            'docs',
            id,
            fresh,
            obj(fx, 'local'),
          );
          expectDeepEqual(
            overwritten,
            fx['expectedServerWins'],
            'fresher server state must win',
          );
          expect(
            overwritten['lOnly'],
            'local-marker',
            reason: 'the accepted merge must descend and keep local-only keys',
          );
        },
      );

      /* ================================================================ */
      /* Scenario 4 — keyed-array reconciliation through the full stack   */
      /* ================================================================ */

      test('4. keyed array: untouched kept, fresh applied, stale rejected, new '
          'appended', () async {
        final fx = scenario('keyedArray');
        final id = docId(fx['docSuffix'] as String);
        await putDoc(id, fx['base']!);

        final client = freshClient();
        final localCopy = await client.reconcileIncoming(
          'docs',
          id,
          obj(fx, 'mutation'),
          obj(fx, 'base'),
        );
        expectDeepEqual(
          localCopy,
          fx['expected'],
          'client-side keyed-array reconcile',
        );

        await client.queueMutation('docs', id, obj(fx, 'mutation'));
        final queued = (await pendingMutations(client)).single;
        final expected = expectedWithQueuedStamp(fx['expected'], queued);
        expect((await flushOne(client, queued, id)).status, 200);

        final serverData = await getDocData(id);
        expectDeepEqual(serverData, expected, 'server keyed-array merge');

        final rows = (serverData['rows'] as List).cast<Map<String, dynamic>>();
        expect(
          rows.length,
          4,
          reason: 'exactly one new identity may be appended',
        );
        expect(
          rows.where((r) => r['id'] == 'r4').length,
          1,
          reason: 'r4 must not be duplicated',
        );
        expect(
          rows[3]['id'],
          'r4',
          reason: 'a new identity is appended at the END of the base array',
        );
        expect(
          rows.firstWhere((r) => r['id'] == 'r3')['label'],
          'server-fresh',
          reason: 'the stale element must not be applied',
        );
        expect(
          rows.firstWhere((r) => r['id'] == 'r1')['label'],
          'untouched',
          reason: 'the untouched element must be preserved',
        );

        // And the client's reconcile of the pulled state agrees.
        expectDeepEqual(
          await client.reconcileIncoming('docs', id, serverData, localCopy),
          expected,
          'client reconcile of the pulled keyed array',
        );
      });

      /* ================================================================ */
      /* Scenario 5 — replay / retry idempotency                         */
      /* ================================================================ */

      test('5. replaying the same queued mutation leaves the document '
          'semantically unchanged', () async {
        final fx = scenario('replayIdempotency');
        final id = docId(fx['docSuffix'] as String);
        await putDoc(id, fx['base']!);

        final client = freshClient();
        await client.queueMutation('docs', id, obj(fx, 'mutation'));
        final queued = (await pendingMutations(client)).single;
        final payload = jsonDecode(queued.jsonPayload) as Map<String, dynamic>;
        final expected = expectedWithQueuedStamp(fx['expected'], queued);

        // First flush.
        expect((await syncDoc(id, payload)).status, 200);
        final afterFirst = await getDocRow(id);
        expectDeepEqual(
          afterFirst['data'],
          expected,
          'document after first flush',
        );

        // Ambiguous network failure: the client never learned the first attempt
        // landed, so it replays the very same payload.
        expect((await syncDoc(id, payload)).status, 200);
        final afterSecond = await getDocRow(id);

        expect(
          afterSecond['version'] as int,
          greaterThan(afterFirst['version'] as int),
          reason: 'the replay must really have written',
        );
        expectDeepEqual(
          afterSecond['data'],
          afterFirst['data'],
          'replay must not change the document',
        );
        expectDeepEqual(afterSecond['data'], expected, 'document after replay');
        expect(
          ((afterSecond['data'] as Map)['tags'] as List).length,
          2,
          reason: 'identity-less array elements must not duplicate on replay',
        );
        expect(
          ((afterSecond['data'] as Map)['rows'] as List).length,
          2,
          reason: 'keyed array elements must not duplicate on replay',
        );

        await markMutation(client, queued.id, SyncStatus.synced);
        expect(await statusCounts(client), const StatusCounts(1, 0, 1, 0));
      });

      /* ================================================================ */
      /* Scenario 6 — failure marking                                    */
      /* ================================================================ */

      test('6. a mutation against a nonexistent document is marked failed, not '
          'synced', () async {
        final fx = scenario('failureMarking');
        final missingId = docId(fx['missingSuffix'] as String);
        final okId = docId(fx['okSuffix'] as String);
        await putDoc(okId, fx['okBase']!);

        final client = freshClient();
        await client.queueMutation(
          'docs',
          missingId,
          obj(fx, 'mutationDoomed'),
        );

        final doomed = (await pendingMutations(client)).single;
        final res = await flushOne(client, doomed, missingId);
        expect(
          res.status,
          404,
          reason: 'the server must reject an unknown document: ${res.body}',
        );

        expect(
          await statusCounts(client),
          const StatusCounts(1, 0, 0, 1),
          reason:
              'the failed mutation must be FAILED and must not count as '
              'pending or synced',
        );
        final stored = (await allMutations(client)).single;
        expect(stored.syncStatus, SyncStatus.failed);

        // A subsequent good mutation must not inherit the failure.
        await client.queueMutation('docs', okId, obj(fx, 'mutationOk'));
        expect(
          await statusCounts(client),
          const StatusCounts(2, 1, 0, 1),
          reason: 'pending/failed accounting must be per-mutation',
        );
        final good = (await pendingMutations(client)).single;
        expect((await flushOne(client, good, okId)).status, 200);

        expect(
          await statusCounts(client),
          const StatusCounts(2, 0, 1, 1),
          reason: 'final accounting: one synced, one failed, nothing pending',
        );
        expectDeepEqual(
          await getDocData(okId),
          fx['expectedOk'],
          'the good mutation still landed',
        );
      });

      test(
        '8. SDK protocol envelope round-trips and an ambiguous retry is deduplicated',
        () async {
          final id =
              '${docId('protocol-v1')}-'
              '${DateTime.now().microsecondsSinceEpoch}';
          final client = freshClient();
          await client.queueMutation('docs', id, {
            'title': 'from-dart-sdk',
          }, baseRevision: '0');

          final envelope = await client.protocolPushRequest();
          final mutations = envelope['mutations'] as List<dynamic>;
          expect((mutations.single as Map)['operation'], 'upsert');
          final first = await protocolPush(envelope);
          expect(first.status, 200, reason: first.body);
          final firstJson = first.json as Map<String, dynamic>;
          expect(
            (firstJson['results'] as List).first['status'],
            'applied',
            reason: first.body,
          );
          expect(
            (firstJson['results'] as List).first['document']['record']['title'],
            'from-dart-sdk',
          );
          expect(await client.acknowledgePush(firstJson, envelope), 1);
          expect(await client.pendingMutations(), isEmpty);

          final retry = await protocolPush(envelope);
          expect(retry.status, 200, reason: retry.body);
          final retryResult =
              ((retry.json as Map<String, dynamic>)['results'] as List).first
                  as Map<String, dynamic>;
          expect(retryResult['status'], 'duplicate');
          expect(retryResult['originalStatus'], 'applied');
          expect(retryResult['document']['record']['title'], 'from-dart-sdk');
        },
      );
    },
    skip: skipReason == null ? null : 'server unavailable: $skipReason',
  );
}
