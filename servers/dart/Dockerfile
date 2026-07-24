# --- Stage 1: Build ---
FROM dart:3.4 AS builder
RUN apt-get update && apt-get install -y gcc make

WORKDIR /build

# Copy syncer.c core
COPY syncer.c/core/ /build/syncer-core/
WORKDIR /build/syncer-core
RUN gcc -shared -fPIC -O3 -Iinclude src/syncer.c src/yyjson.c -o libsyncer.so

# Copy Dart binding
COPY syncer.c/bindings/dart/ /build/syncer-dart/

# Copy the Dart server source
COPY opto-sync-e2e/servers/dart/ /build/app/
WORKDIR /build/app

# Fix paths for Docker environment
RUN sed -i 's|../../../syncer.c/bindings/dart|../syncer-dart|g' pubspec.yaml

RUN dart pub get 2>/dev/null || true
RUN dart compile exe bin/server.dart -o bin/server 2>/dev/null || true

# --- Stage 2: Runtime ---
FROM gcr.io/distroless/cc-debian12
COPY --from=builder /build/syncer-core/libsyncer.so /usr/lib/libsyncer.so
COPY --from=builder /build/app/bin/server /app/server 2>/dev/null || true
EXPOSE 3004
CMD ["/app/server"]
