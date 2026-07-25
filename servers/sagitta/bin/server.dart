import 'dart:convert';
import 'dart:io';
import 'package:shelf/shelf.dart';
import 'package:shelf/shelf_io.dart' as io;
import 'package:shelf_router/shelf_router.dart';
import 'package:syncer/syncer.dart';

// ── In-memory store ───────────────────────────────────────────────────────

class Doc {
  String id;
  String data; // raw json string
  int version;
  Doc(this.id, this.data, this.version);
}

final db = <String, Doc>{};

// ── Main ─────────────────────────────────────────────────────────────────

Future<void> main() async {
  print('[sagitta] Initializing on port 3005...');

  // Seed documents
  db['doc-s1'] = Doc(
    'doc-s1',
    jsonEncode({
      'title': 'Sagitta Alpha',
      'metadata': {'tags': ['dart', 'shelf'], 'priority': 1},
      'updatedAt': '1000000000000000000',
    }),
    1,
  );
  db['doc-s2'] = Doc(
    'doc-s2',
    jsonEncode({
      'title': 'Sagitta Beta',
      'settings': {'theme': 'light', 'lang': 'en'},
      'updatedAt': '1000000000000000000',
    }),
    1,
  );

  // Load native syncer
  String libPath;
  if (Platform.isMacOS) {
    libPath = 'libsyncer.dylib';
  } else {
    libPath = '/usr/lib/libsyncer.so';
  }

  late Syncer syncer;
  bool nativeLoaded = false;
  try {
    syncer = Syncer(libPath);
    nativeLoaded = true;
    print('[sagitta] Native C FFI loaded (core ${syncer.version})');
  } catch (e) {
    // Fail closed, like the node and dart servers: a server that boots without
    // the merge engine answers every sync with a 500, which reads as a flaky
    // suite rather than the misconfiguration it is. Refuse to start unless
    // SYNCER_REQUIRE_NATIVE=0 explicitly allows a degraded boot.
    print('[sagitta] FATAL: native FFI not loaded: $e');
    if (Platform.environment['SYNCER_REQUIRE_NATIVE'] != '0') {
      exit(1);
    }
    print('[sagitta] SYNCER_REQUIRE_NATIVE=0, continuing without the engine');
  }

  final app = Router();

  // Health check
  app.get('/health', (Request req) {
    return Response.ok(
      jsonEncode({
        'status': 'ok',
        'server': 'sagitta',
        'syncer': nativeLoaded ? 'native-c-ffi' : 'unavailable',
      }),
      headers: {'Content-Type': 'application/json'},
    );
  });

  // SSR index page
  app.get('/', (Request req) {
    final docCards = db.values.map((d) {
      final data = jsonDecode(d.data) as Map<String, dynamic>;
      return '<div class="card"><h3>${d.id} (v${d.version})</h3>'
          '<pre>${const JsonEncoder.withIndent('  ').convert(data)}</pre></div>';
    }).join('\n');

    return Response.ok('''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>opto-sync — Sagitta Stack</title>
  <style>
    body { font-family: system-ui; max-width: 800px; margin: 2rem auto; background: #0d1117; color: #c9d1d9; }
    h1 { color: #58a6ff; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
    pre { background: #0d1117; padding: 0.5rem; border-radius: 4px; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>🎯 opto-sync — Sagitta Stack</h1>
  <p>Full-Stack Dart (Shelf SSR) with native C FFI CRDT merging.</p>
  $docCards
</body>
</html>''', headers: {'Content-Type': 'text/html'});
  });

  // List documents
  app.get('/docs', (Request req) {
    final docs = db.values.map((d) => {
          'id': d.id,
          'data': jsonDecode(d.data),
          'version': d.version,
        }).toList();
    return Response.ok(jsonEncode(docs), headers: {'Content-Type': 'application/json'});
  });

  // Get single document
  app.get('/doc/<id>', (Request req, String id) {
    final doc = db[id];
    if (doc == null) {
      return Response.notFound(
        jsonEncode({'error': 'not found'}),
        headers: {'Content-Type': 'application/json'},
      );
    }
    return Response.ok(
      jsonEncode({'id': doc.id, 'data': jsonDecode(doc.data), 'version': doc.version}),
      headers: {'Content-Type': 'application/json'},
    );
  });

  // Sync endpoint — CRDT merge
  app.post('/doc/<id>/sync', (Request req, String id) async {
    final doc = db[id];
    if (doc == null) {
      return Response.notFound(
        jsonEncode({'error': 'not found'}),
        headers: {'Content-Type': 'application/json'},
      );
    }

    final payload = await req.readAsString();

    if (!nativeLoaded) {
      return Response.internalServerError(
        body: jsonEncode({'error': 'native syncer not available'}),
        headers: {'Content-Type': 'application/json'},
      );
    }

    try {
      final merged = syncer.merge(
        doc.data,
        payload,
        options: MergeOptions(
          // Same policy as every other opto-sync server, so the conformance
          // expectations are uniform across runtimes.
          arrayStrategy: ArrayMergeStrategy.mergeByKey,
          arrayMatchKeys: 'id',
          resolveByTimestamp: true,
          lwwKeys: 'updatedAt,syncedAt',
          fwwKeys: 'createdAt',
        ),
      );

      doc.data = merged;
      doc.version += 1;

      return Response.ok(
        jsonEncode({
          'merged': true,
          'document': {
            'id': doc.id,
            'data': jsonDecode(doc.data),
            'version': doc.version,
          },
          'mergedWith': 'native-c-ffi-sagitta',
        }),
        headers: {'Content-Type': 'application/json'},
      );
    } catch (e) {
      return Response.internalServerError(
        body: jsonEncode({'error': e.toString()}),
        headers: {'Content-Type': 'application/json'},
      );
    }
  });

  final handler = Pipeline().addMiddleware(logRequests()).addHandler(app.call);

  final server = await io.serve(handler, '0.0.0.0', 3005);
  print('[sagitta] Serving at http://${server.address.host}:${server.port}');
}
