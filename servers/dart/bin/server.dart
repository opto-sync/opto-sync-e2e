import 'dart:convert';
import 'dart:io';
import 'package:shelf/shelf.dart';
import 'package:shelf/shelf_io.dart' as io;
import 'package:shelf_router/shelf_router.dart';
import 'package:syncer/syncer.dart';

// In-memory "database"
class Doc {
  String id;
  String data; // raw json
  int version;

  Doc(this.id, this.data, this.version);
}

final db = <String, Doc>{};

Future<void> main() async {
  print('[dart-server] Initializing on port 3004...');

  // Seed documents
  final seedDocs = [
    Doc('doc1', '{"title": "Initial", "updatedAt": "2026-07-23T00:00:00Z", "nested": {"a": 1}}', 1),
    Doc('doc2', '{"todos": [{"id": 1, "text": "A"}], "updatedAt": "2026-07-23T00:00:00Z"}', 1)
  ];
  
  for (var doc in seedDocs) {
    db[doc.id] = doc;
  }
  
  // Try to load FFI library
  String libraryPath;
  if (Platform.isWindows) {
    libraryPath = 'syncer.dll';
  } else if (Platform.isMacOS) {
    libraryPath = 'libsyncer.dylib';
  } else {
    libraryPath = '/usr/lib/libsyncer.so'; // Default path in Docker
  }
  
  // Syncer class from syncer binding (merge method)
  final syncer = Syncer(libraryPath);
  print('[dart-server] FFI initialized');

  final app = Router();

  app.get('/health', (Request request) {
    return Response.ok(jsonEncode({
      'status': 'ok',
      'server': 'dart-shelf'
    }), headers: {'Content-Type': 'application/json'});
  });

  app.get('/docs', (Request request) {
    final docs = db.values.map((d) => {
      'id': d.id,
      'data': jsonDecode(d.data),
      'version': d.version
    }).toList();
    return Response.ok(jsonEncode(docs), headers: {'Content-Type': 'application/json'});
  });

  app.get('/doc/<id>', (Request request, String id) {
    final doc = db[id];
    if (doc == null) {
      return Response.notFound(jsonEncode({'error': 'not found'}), headers: {'Content-Type': 'application/json'});
    }
    return Response.ok(jsonEncode({
      'id': doc.id,
      'data': jsonDecode(doc.data),
      'version': doc.version
    }), headers: {'Content-Type': 'application/json'});
  });

  app.post('/doc/<id>/sync', (Request request, String id) async {
    final doc = db[id];
    if (doc == null) {
      return Response.notFound(jsonEncode({'error': 'not found'}), headers: {'Content-Type': 'application/json'});
    }
    
    final payload = await request.readAsString();
    
    // Merge using C FFI
    try {
      final mergedRaw = syncer.merge(
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
      
      doc.data = mergedRaw;
      doc.version += 1;
      
      return Response.ok(jsonEncode({
        'merged': true,
        'document': {
          'id': doc.id,
          'data': jsonDecode(doc.data),
          'version': doc.version
        },
        'mergedWith': 'native-c-ffi'
      }), headers: {'Content-Type': 'application/json'});
    } catch (e) {
      return Response.internalServerError(
        body: jsonEncode({'error': e.toString()}),
        headers: {'Content-Type': 'application/json'}
      );
    }
  });

  final handler = const Pipeline()
      .addMiddleware(logRequests())
      .addHandler(app.call);

  final server = await io.serve(handler, '0.0.0.0', 3004);
  print('[dart-server] Serving at http://${server.address.host}:${server.port}');
}
