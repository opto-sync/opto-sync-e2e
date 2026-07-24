# --- Stage 1: Build ---
FROM dart:3.4 AS builder
WORKDIR /build
COPY syncer.c/core/ /build/syncer-core/
COPY syncer.c/bindings/dart/ /build/syncer-dart/
COPY opto-sync-e2e/servers/sagitta/ /build/app/
WORKDIR /build/app
RUN dart pub get 2>/dev/null || true
RUN dart compile exe bin/server.dart -o bin/server 2>/dev/null || true

# --- Stage 2: Runtime ---
FROM gcr.io/distroless/cc-debian12
COPY --from=builder /build/app/bin/server /app/server 2>/dev/null || true
EXPOSE 3005
CMD ["/app/server"]
