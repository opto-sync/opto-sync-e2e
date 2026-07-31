/// Shared support for the opto_sync_client client-in-the-loop e2e suite.
///
/// Dependency-free by design (dart:io + dart:convert only) so the suite runs
/// offline against an already-running server.
library;

import 'dart:convert';
import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:opto_sync_client/opto_sync_client.dart';

const String lang = 'dart';

final String baseUrl =
    (Platform.environment['OPTO_SYNC_SERVER_URL'] ?? 'http://localhost:3003')
        .replaceAll(RegExp(r'/$'), '');

/* ------------------------------------------------------------------ */
/* Native core + fixtures                                             */
/* ------------------------------------------------------------------ */

/// Locate the syncer.c core shared library independent of the working
/// directory: honor SYNCER_LIB_PATH, else walk up looking for
/// `syncer.c/core/build/<platform lib>`.
String locateCoreLibrary() {
  final env = Platform.environment['SYNCER_LIB_PATH'];
  if (env != null && env.isNotEmpty) return env;

  for (final start in _searchRoots()) {
    var dir = Directory(start);
    for (var i = 0; i < 12; i++) {
      final buildDir =
          '${dir.path}${Platform.pathSeparator}syncer.c'
          '${Platform.pathSeparator}core${Platform.pathSeparator}build';
      if (Directory(buildDir).existsSync()) {
        final path = resolveSyncerLibraryPath(directory: buildDir);
        if (File(path).existsSync()) return path;
      }
      final parent = dir.parent;
      if (parent.path == dir.path) break;
      dir = parent;
    }
  }
  throw StateError(
    'Could not locate syncer.c/core/build/<libsyncer>. Build the core or set '
    'SYNCER_LIB_PATH.',
  );
}

List<String> _searchRoots() {
  final roots = <String>[Directory.current.absolute.path];
  try {
    roots.add(File.fromUri(Platform.script).parent.absolute.path);
  } catch (_) {
    /* Platform.script is not a file under some runners */
  }
  return roots;
}

/// Walk up from the current directory (and the script directory) to find
/// `test/clients/fixtures`, so the suite works from any cwd.
Directory _fixturesDir() {
  for (final start in _searchRoots()) {
    var dir = Directory(start);
    for (var i = 0; i < 12; i++) {
      final candidate = Directory(
        '${dir.path}${Platform.pathSeparator}test'
        '${Platform.pathSeparator}clients${Platform.pathSeparator}fixtures',
      );
      if (candidate.existsSync()) return candidate;
      final sibling = Directory('${dir.path}${Platform.pathSeparator}fixtures');
      if (sibling.existsSync() &&
          File(
            '${sibling.path}${Platform.pathSeparator}scenarios.json',
          ).existsSync()) {
        return sibling;
      }
      final parent = dir.parent;
      if (parent.path == dir.path) break;
      dir = parent;
    }
  }
  throw StateError('Could not locate test/clients/fixtures');
}

Map<String, dynamic> loadFixture(String name) {
  final file = File('${_fixturesDir().path}${Platform.pathSeparator}$name');
  return jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
}

final Map<String, dynamic> scenariosFixture = loadFixture('scenarios.json');
final Map<String, dynamic> crossClientFixture = loadFixture(
  'cross_client.json',
);

Map<String, dynamic> scenario(String name) =>
    (scenariosFixture['scenarios'] as Map<String, dynamic>)[name]
        as Map<String, dynamic>;

/// Namespaced document id so the three language suites never collide.
String docId(String suffix) =>
    '${scenariosFixture['docIdPrefix']}-$lang-$suffix';

/// A payload from a fixture, as a fresh mutable map.
Map<String, dynamic> obj(Map<String, dynamic> parent, String key) =>
    jsonDecode(jsonEncode(parent[key])) as Map<String, dynamic>;

List<dynamic> arr(Map<String, dynamic> parent, String key) =>
    jsonDecode(jsonEncode(parent[key])) as List<dynamic>;

/* ------------------------------------------------------------------ */
/* Client construction                                                */
/* ------------------------------------------------------------------ */

/// The Dart client's FfiSyncer already defaults to the server's policy
/// (mergeByKey on 'id', resolveByTimestamp, lww updatedAt/syncedAt, and NO fww
/// key), so the defaults are used deliberately and unmodified — that IS the
/// assertion. `createdAt` is deliberately not an FWW key on any tier: FWW is a
/// node-level veto, so it would let a replica holding a later createdAt lock a
/// record permanently.
FfiSyncer newSyncer() => FfiSyncer(libraryPath: locateCoreLibrary());

/// A client over a private in-memory queue.
OptoSyncClient newClient(FfiSyncer syncer) => OptoSyncClient(
  db: OptoSyncDatabase(NativeDatabase.memory()),
  syncer: syncer,
);

/* ------------------------------------------------------------------ */
/* Queue access (the client ships no transport, so the flush lives here) */
/* ------------------------------------------------------------------ */

Future<List<Mutation>> allMutations(OptoSyncClient client) => (client.db.select(
  client.db.localMutations,
)..orderBy([(t) => OrderingTerm.asc(t.id)])).get();

Future<List<Mutation>> pendingMutations(OptoSyncClient client) =>
    (client.db.select(client.db.localMutations)
          ..where((t) => t.syncStatus.equals(SyncStatus.pending))
          ..orderBy([(t) => OrderingTerm.asc(t.id)]))
        .get();

Future<void> markMutation(OptoSyncClient client, int id, int syncStatus) async {
  final updated =
      await (client.db.update(client.db.localMutations)
            ..where((t) => t.id.equals(id)))
          .write(LocalMutationsCompanion(syncStatus: Value(syncStatus)));
  if (updated != 1) {
    throw StateError('markMutation($id) touched $updated rows, expected 1');
  }
}

class StatusCounts {
  final int total, pending, synced, failed;
  const StatusCounts(this.total, this.pending, this.synced, this.failed);

  @override
  bool operator ==(Object other) =>
      other is StatusCounts &&
      other.total == total &&
      other.pending == pending &&
      other.synced == synced &&
      other.failed == failed;

  @override
  int get hashCode => Object.hash(total, pending, synced, failed);

  @override
  String toString() =>
      '{total: $total, pending: $pending, synced: $synced, failed: $failed}';
}

Future<StatusCounts> statusCounts(OptoSyncClient client) async {
  final rows = await allMutations(client);
  return StatusCounts(
    rows.length,
    rows.where((m) => m.syncStatus == SyncStatus.pending).length,
    rows.where((m) => m.syncStatus == SyncStatus.synced).length,
    rows.where((m) => m.syncStatus == SyncStatus.failed).length,
  );
}

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */

class HttpResult {
  final int status;
  final String body;
  final dynamic json;
  HttpResult(this.status, this.body, this.json);
  bool get ok => status >= 200 && status < 300;
}

Future<HttpResult> _request(
  String method,
  String path, {
  Object? body,
  Duration timeout = const Duration(seconds: 10),
}) async {
  final http = HttpClient()..connectionTimeout = timeout;
  try {
    final req = await http.openUrl(method, Uri.parse('$baseUrl$path'));
    if (body != null) {
      final encoded = utf8.encode(jsonEncode(body));
      req.headers.contentType = ContentType.json;
      req.contentLength = encoded.length;
      req.add(encoded);
    }
    final res = await req.close().timeout(timeout);
    final text = await utf8.decodeStream(res);
    dynamic decoded;
    try {
      decoded = text.isEmpty ? null : jsonDecode(text);
    } catch (_) {
      decoded = null;
    }
    return HttpResult(res.statusCode, text, decoded);
  } finally {
    http.close(force: true);
  }
}

/// Probe the server. `null` when healthy, otherwise a human-readable reason so
/// the suite SKIPs with a clear message instead of hanging on a dead socket.
Future<String?> probeServer() async {
  try {
    final res = await _request(
      'GET',
      '/health',
      timeout: const Duration(seconds: 3),
    );
    if (!res.ok) return '$baseUrl/health returned HTTP ${res.status}';
    final health = res.json as Map<String, dynamic>;
    if (health['status'] != 'ok') {
      return '$baseUrl/health reported status=${health['status']}';
    }
    if (health['syncer'] != 'native') {
      return 'server is running the ${health['syncer']} merge, not the native '
          'syncer.c core — client/server convergence would be meaningless';
    }
    return null;
  } catch (e) {
    return '$baseUrl is unreachable ($e). Start the stack '
        '(docker compose up -d postgres node) or set OPTO_SYNC_SERVER_URL.';
  }
}

Future<void> putDoc(String id, Object payload) async {
  final res = await _request(
    'PUT',
    '/doc/${Uri.encodeComponent(id)}',
    body: payload,
  );
  if (!res.ok) {
    throw StateError('PUT /doc/$id failed: HTTP ${res.status} ${res.body}');
  }
}

Future<Map<String, dynamic>> getDocRow(String id) async {
  final res = await _request('GET', '/doc/${Uri.encodeComponent(id)}');
  if (!res.ok) {
    throw StateError('GET /doc/$id failed: HTTP ${res.status} ${res.body}');
  }
  return res.json as Map<String, dynamic>;
}

Future<Map<String, dynamic>> getDocData(String id) async =>
    (await getDocRow(id))['data'] as Map<String, dynamic>;

/// Exact stored jsonb text — proves the suite never depends on key ordering.
Future<String> getDocRaw(String id) async {
  final res = await _request('GET', '/doc/${Uri.encodeComponent(id)}/raw');
  if (!res.ok) {
    throw StateError('GET /doc/$id/raw failed: HTTP ${res.status} ${res.body}');
  }
  return res.body;
}

/// POST /doc/:id/sync — returns the result even on 4xx so failure-marking
/// scenarios can inspect the status the way a client would.
Future<HttpResult> syncDoc(String id, Object payload, {bool noRetry = false}) =>
    _request(
      'POST',
      '/doc/${Uri.encodeComponent(id)}/sync${noRetry ? '?noRetry=1' : ''}',
      body: payload,
    );

/// POST /sync/batch — the shape an offline queue flushes in.
Future<Map<String, dynamic>> syncBatch(
  List<Map<String, Object?>> mutations,
) async {
  final res = await _request(
    'POST',
    '/sync/batch',
    body: {'mutations': mutations},
  );
  if (!res.ok) {
    throw StateError('POST /sync/batch failed: HTTP ${res.status} ${res.body}');
  }
  return res.json as Map<String, dynamic>;
}

/// POST one SDK-produced protocol v1 envelope without rewriting its fields.
Future<HttpResult> protocolPush(Map<String, dynamic> envelope) =>
    _request('POST', '/v1/sync/push', body: envelope);

Future<HttpResult> protocolPull(
  String checkpoint, {
  int limit = 100,
}) => _request(
  'GET',
  '/v1/sync/pull?checkpoint=${Uri.encodeQueryComponent(checkpoint)}&limit=$limit',
);

Future<HttpResult> protocolSnapshot() => _request('GET', '/v1/sync/snapshot');

/* ------------------------------------------------------------------ */
/* Semantic comparison                                                */
/* ------------------------------------------------------------------ */

/// Structural equality over DECODED JSON values. Postgres jsonb reorders object
/// keys, so raw strings are never compared anywhere in this suite.
bool deepEquals(dynamic a, dynamic b) {
  if (a is Map && b is Map) {
    if (a.length != b.length) return false;
    for (final k in a.keys) {
      if (!b.containsKey(k) || !deepEquals(a[k], b[k])) return false;
    }
    return true;
  }
  if (a is List && b is List) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!deepEquals(a[i], b[i])) return false;
    }
    return true;
  }
  if (a is num && b is num) return a == b;
  return a == b;
}

/// Sort every array-of-objects-with-`id` by id, recursively, and sort object
/// keys so rendering is stable.
///
/// MERGE_BY_KEY matches array elements by IDENTITY, not position, so when a
/// client merges the server's document into a local copy that started with a
/// different subset of identities the resulting order legitimately differs while
/// the identity set and every element's content must match exactly. Only used
/// where order is genuinely undetermined; the server document is compared
/// strictly.
dynamic normalizeKeyedArrays(dynamic value) {
  if (value is List) {
    final mapped = value.map(normalizeKeyedArrays).toList();
    final allKeyed =
        mapped.isNotEmpty &&
        mapped.every((v) => v is Map && v.containsKey('id'));
    if (allKeyed) {
      mapped.sort(
        (x, y) => '${(x as Map)['id']}'.compareTo('${(y as Map)['id']}'),
      );
    }
    return mapped;
  }
  if (value is Map) {
    final keys = value.keys.map((k) => '$k').toList()..sort();
    return {for (final k in keys) k: normalizeKeyedArrays(value[k])};
  }
  return value;
}

String render(dynamic value) =>
    const JsonEncoder.withIndent('  ').convert(normalizeKeyedArrays(value));

/// Thrown by the assertion helpers below so both the `test` suite and the
/// standalone converge runner can use them.
class ComparisonFailure implements Exception {
  final String message;
  ComparisonFailure(this.message);
  @override
  String toString() => message;
}

void expectDeepEqual(dynamic actual, dynamic expected, String what) {
  if (deepEquals(actual, expected)) return;
  throw ComparisonFailure(
    '$what: parsed values differ.\n'
    '--- expected ---\n${render(expected)}\n'
    '--- actual ---\n${render(actual)}',
  );
}

/// Deep equality that treats keyed arrays as identity sets.
void expectDeepEqualKeyed(dynamic actual, dynamic expected, String what) {
  final na = normalizeKeyedArrays(actual);
  final ne = normalizeKeyedArrays(expected);
  if (deepEquals(na, ne)) return;
  throw ComparisonFailure(
    '$what: parsed values differ (keyed arrays normalized by id).\n'
    '--- expected ---\n${render(ne)}\n'
    '--- actual ---\n${render(na)}',
  );
}

void expectTrue(bool condition, String what) {
  if (!condition) throw ComparisonFailure(what);
}
