import 'dart:convert';
import 'dart:io';

import 'package:drift/native.dart';
import 'package:opto_sync_client/opto_sync_client.dart';

import '../lib/support.dart';

Never _fail(String message) => throw StateError(message);

Future<void> main(List<String> args) async {
  if (args.length != 4 || !const {'prepare', 'recover'}.contains(args[0])) {
    stderr.writeln(
      'usage: dart run bin/protocol_restart.dart '
      '<prepare|recover> <sqlite-file> <envelope-file> <record-id>',
    );
    exitCode = 2;
    return;
  }

  final phase = args[0];
  final sqliteFile = File(args[1]);
  final envelopeFile = File(args[2]);
  final snapshotFile = File('${envelopeFile.path}.snapshot');
  final authoritativeFile = File('${envelopeFile.path}.authoritative');
  final recordId = args[3];
  if (phase == 'prepare' &&
      (sqliteFile.existsSync() ||
          envelopeFile.existsSync() ||
          snapshotFile.existsSync() ||
          authoritativeFile.existsSync())) {
    _fail('prepare requires fresh SQLite and envelope files');
  }
  final db = OptoSyncDatabase(NativeDatabase(sqliteFile));
  final client = OptoSyncClient(db: db, syncer: newSyncer());

  try {
    if (phase == 'prepare') {
      await client.queueMutation('docs', recordId, {
        'title': 'dart survived server-commit/client-ack restart',
      }, baseRevision: '0');
      final envelope = await client.protocolPushRequest();
      envelopeFile.writeAsStringSync(jsonEncode(envelope), flush: true);

      final committed = await protocolPush(envelope);
      if (committed.status != 200) {
        _fail(
          'initial push failed: HTTP ${committed.status} ${committed.body}',
        );
      }
      final result =
          ((committed.json as Map<String, dynamic>)['results'] as List).single
              as Map<String, dynamic>;
      if (result['status'] != 'applied') {
        _fail('initial push was not applied: ${committed.body}');
      }
      if ((await client.pendingMutations()).length != 1) {
        _fail('prepare accidentally acknowledged or lost the pending mutation');
      }

      final snapshotResponse = await protocolSnapshot();
      if (snapshotResponse.status != 200) {
        _fail(
          'snapshot failed: HTTP ${snapshotResponse.status} '
          '${snapshotResponse.body}',
        );
      }
      final snapshot = snapshotResponse.json as Map<String, dynamic>;
      snapshotFile.writeAsStringSync(jsonEncode(snapshot), flush: true);
      var interrupted = false;
      try {
        await client.installSnapshot(snapshot, (records) async {
          authoritativeFile.writeAsStringSync('partial', flush: true);
          throw StateError('injected snapshot replacement interruption');
        });
      } on StateError {
        interrupted = true;
      }
      if (!interrupted ||
          await client.pullCheckpoint() != '0' ||
          (await client.pendingMutations()).length != 1) {
        _fail(
          'interrupted snapshot advanced checkpoint or changed pending work',
        );
      }
      stdout.writeln(
        'ok - [dart/restart prepare] committed without local ack; '
        'snapshot replacement interrupted',
      );
      return;
    }

    if (!sqliteFile.existsSync() ||
        !envelopeFile.existsSync() ||
        !snapshotFile.existsSync() ||
        !authoritativeFile.existsSync()) {
      _fail('recover requires files created by the prepare process');
    }
    final pendingBefore = await client.pendingMutations();
    if (pendingBefore.length != 1) {
      _fail(
        'expected one recovered pending mutation, got ${pendingBefore.length}',
      );
    }
    if (await client.pullCheckpoint() != '0' ||
        authoritativeFile.readAsStringSync() != 'partial') {
      _fail('new process did not observe the interrupted snapshot state');
    }

    final snapshot =
        jsonDecode(snapshotFile.readAsStringSync()) as Map<String, dynamic>;
    await client.installSnapshot(snapshot, (records) async {
      final replacement = File('${authoritativeFile.path}.replacement');
      replacement.writeAsStringSync(jsonEncode(records), flush: true);
      replacement.renameSync(authoritativeFile.path);
    });
    if (await client.pullCheckpoint() != snapshot['checkpoint'] ||
        (await client.pendingMutations()).length != 1 ||
        authoritativeFile.readAsStringSync() == 'partial') {
      _fail('snapshot retry did not atomically repair authoritative state');
    }

    final reconstructed = await client.protocolPushRequest();
    final original =
        jsonDecode(envelopeFile.readAsStringSync()) as Map<String, dynamic>;
    if (!deepEquals(reconstructed, original)) {
      _fail(
        'recovered SDK envelope changed across processes:\n'
        'original=${jsonEncode(original)}\n'
        'recovered=${jsonEncode(reconstructed)}',
      );
    }

    final retry = await protocolPush(reconstructed);
    if (retry.status != 200) {
      _fail('retry failed: HTTP ${retry.status} ${retry.body}');
    }
    final retryJson = retry.json as Map<String, dynamic>;
    final result =
        (retryJson['results'] as List).single as Map<String, dynamic>;
    if (result['status'] != 'duplicate' ||
        result['originalStatus'] != 'applied') {
      _fail('server did not deduplicate recovered retry: ${retry.body}');
    }
    if (await client.acknowledgePush(retryJson, reconstructed) != 1) {
      _fail('recovered acknowledgement did not confirm exactly one mutation');
    }
    if ((await client.pendingMutations()).isNotEmpty) {
      _fail('pending queue was not drained after recovered acknowledgement');
    }
    stdout.writeln(
      'ok - [dart/restart recover] snapshot repaired; '
      'identical retry deduplicated and acknowledged',
    );
  } finally {
    await db.close();
  }
}
