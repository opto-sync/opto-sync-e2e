# --- Stage 1: Build ---
FROM rust:latest AS builder
RUN apt-get update && apt-get install -y pkg-config libssl-dev
RUN rustup target add wasm32-unknown-unknown
RUN cargo install trunk

WORKDIR /build

# Copy syncer.c core
COPY syncer.c/core/ /build/syncer-core/
COPY syncer.c/bindings/rust/ /build/syncer-rs/

# Copy the fullstack Rust server source
COPY opto-sync-e2e/servers/rust-fullstack/ /build/app/
WORKDIR /build/app
RUN cargo build --release 2>&1 || echo "Build placeholder"

# --- Stage 2: Runtime ---
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/app/target/release/rust-fullstack /usr/local/bin/server
EXPOSE 3002
CMD ["server"]
