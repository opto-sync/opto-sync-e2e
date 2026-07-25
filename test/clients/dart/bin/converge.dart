/// Scenario 7 phase runner for opto_sync_client — cross-client convergence.
///
/// Invoked by run_all.sh as one step of an orchestrated sequence:
///
///   dart run bin/converge.dart setup    # PUT the fresh fixture document
///   dart run bin/converge.dart flush    # queue this client's payload and flush it
///   dart run bin/converge.dart verify   # assert the final server doc + local reconcile
///
/// Split into phases on purpose: `flush` must run once per language, in the
/// fixture's declared order, against the SAME document, so the phases cannot
/// live inside a single language's test process.
library;

import 'dart:convert';
import 'dart:io';

import 'package:opto_sync_client/opto_sync_client.dart';
import 'package:opto_sync_client_e2e/support.dart';

const String _lang = 'dart';
late String _phase;
int _checks = 0;

void _ok(String what) {
  _checks += 1;
  stdout.writeln('ok - [$_lang/converge/$_phase] $what');
}

void _check(bool condition, String what) {
  if (!condition) throw ComparisonFailure(what);
  _ok(what);
}

void _checkEqual(dynamic actual, dynamic expected, String what) {
  expectDeepEqual(actual, expected, what);
  _ok(what);
}

Map<String, dynamic> get _payload {
  final payloads = crossClientFixture['payloads'] as Map<String, dynamic>;
  final p = payloads[_lang];
  if (p == null) throw StateError('fixture has no payload for "$_lang"');
  return jsonDecode(jsonEncode(p)) as Map<String, dynamic>;
}

String get _docId => crossClientFixture['docId'] as String;

Future<void> _setup() async {
  await putDoc(_docId, crossClientFixture['base']!);
  _checkEqual(await getDocData(_docId), crossClientFixture['base'],
      'fresh document $_docId written');
}

Future<void> _flush() async {
  final client = newClient(newSyncer());
  try {
    await client.queueMutation('docs', _docId, _payload);
    final pending = await pendingMutations(client);
    _check(pending.length == 1, 'payload queued as pending');

    final queued = pending.single;
    final res = await syncDoc(
        _docId, jsonDecode(queued.jsonPayload) as Map<String, dynamic>);
    await markMutation(
        client, queued.id, res.ok ? SyncStatus.synced : SyncStatus.failed);
    _check(res.status == 200, 'flushed to $_docId (HTTP ${res.status})');
    _check((res.json as Map)['mergedWith'] == 'native-c-ffi',
        'server merged with the native C core');

    final counts = await statusCounts(client);
    _check(counts.synced == 1 && counts.pending == 0 && counts.failed == 0,
        'queue drained ($counts)');
  } finally {
    await client.db.close();
  }
}

Future<void> _verify() async {
  final serverFinal = await getDocData(_docId);
  final expected = crossClientFixture['expectedFinal'] as Map<String, dynamic>;

  // (a) strict, order-sensitive: the server document is fully determined.
  _checkEqual(serverFinal, expected,
      'final server document matches the predicted merge exactly');

  // Spot-check the load-bearing policy claims, so a failure names the rule.
  final revision = serverFinal['revision'] as Map<String, dynamic>;
  final items = (serverFinal['items'] as List).cast<Map<String, dynamic>>();

  _check(serverFinal['title'] == 'rust title',
      'unguarded root scalar follows arrival order (last flusher wins)');
  _check(revision['owner'] == 'dart' && revision['updatedAt'] == 4000,
      'guarded object follows updatedAt, NOT flush order: rust flushed last but is stale');
  _check(revision['priority'] == 2, "rust's stale revision was rejected WHOLESALE");
  // Base-only root scalar: no client payload sends a root `createdAt`, so
  // nothing can overwrite it. (`createdAt` is no longer a guarded key on any
  // tier — FWW is a node-level veto and is opt-in.)
  _check(serverFinal['createdAt'] == 1000,
      'base-only root createdAt untouched by every client');
  _check(items.length == 5, 'exactly three new identities appended');

  final shared = items.firstWhere((i) => i['id'] == 'shared');
  _check(
      shared['label'] == 'dart-shared' &&
          shared['qty'] == 20 &&
          shared['createdAt'] == 1000,
      "the shared element carries dart's write deep-merged onto the base element");
  _check(items.firstWhere((i) => i['id'] == 'keep')['label'] == 'untouched',
      'the element nobody touched is preserved verbatim');
  _check(items.map((i) => i['id']).join(',') == 'keep,shared,ts-new,dart-new,rust-new',
      'appended identities appear in flush order at the end of the array');

  // (b) this client's own local reconcile of the final state.
  final client = newClient(newSyncer());
  try {
    final reconciled =
        await client.reconcileIncoming('docs', _docId, serverFinal, _payload);
    expectDeepEqualKeyed(reconciled, expected,
        '$_lang local reconcile of the final server state');
    _ok('$_lang local reconcile of the final server state agrees with every '
        'other client');
  } finally {
    await client.db.close();
  }
}

Future<void> main(List<String> args) async {
  final phases = <String, Future<void> Function()>{
    'setup': _setup,
    'flush': _flush,
    'verify': _verify,
  };

  _phase = args.isEmpty ? '' : args.first;
  final run = phases[_phase];
  if (run == null) {
    stderr.writeln(
        'usage: dart run bin/converge.dart <${phases.keys.join('|')}>');
    exit(2);
  }

  final reason = await probeServer();
  if (reason != null) {
    stderr.writeln('[$_lang] SKIP converge/$_phase — server unavailable: $reason');
    exit(0);
  }

  try {
    await run();
  } catch (e) {
    stderr.writeln('not ok - [$_lang/converge/$_phase] $e');
    exit(1);
  }
  stdout.writeln(
      '# [$_lang] converge/$_phase: $_checks checks passed against $baseUrl');
}
