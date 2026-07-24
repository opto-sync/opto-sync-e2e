# --- Stage 1: Build ---
FROM dart:3.4 AS builder
RUN apt-get update && apt-get install -y gcc make

WORKDIR /build

# Compile native libsyncer.so
COPY syncer.c/core/ /build/syncer-core/
WORKDIR /build/syncer-core
RUN gcc -shared -fPIC -O3 -Iinclude src/syncer.c src/yyjson.c -o libsyncer.so

WORKDIR /build

# Copy Dart binding and fix path
COPY syncer.c/bindings/dart/ /build/syncer-dart/

# Copy Sagitta server
COPY opto-sync-e2e/servers/sagitta/ /build/app/
WORKDIR /build/app

# Fix path to syncer_dart
RUN sed -i 's|../../../syncer.c/bindings/dart|../syncer-dart|g' pubspec.yaml

RUN dart pub get
RUN dart compile exe bin/server.dart -o bin/server

# --- Stage 2: Runtime ---
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/syncer-core/libsyncer.so /usr/lib/libsyncer.so
COPY --from=builder /build/app/bin/server /app/server
EXPOSE 3005
CMD ["/app/server"]
