# --- Stage 1: Build ---
FROM rust:1.79-alpine AS builder
RUN apk add --no-cache musl-dev gcc make

WORKDIR /build

# Copy syncer.c core and Rust binding
COPY syncer.c/core/ /build/syncer-core/
COPY syncer.c/bindings/rust/ /build/syncer-rs/

# Fix syncer-rs Cargo.toml to point to local core path
RUN sed -i 's|../core|/build/syncer-core|g' /build/syncer-rs/build.rs 2>/dev/null || true

# Copy the fullstack server source
COPY opto-sync-e2e/servers/rust-fullstack/ /build/app/
WORKDIR /build/app

# Fix the syncer-rs path in Cargo.toml
RUN sed -i 's|../../../syncer.c/bindings/rust|/build/syncer-rs|g' Cargo.toml

RUN cargo build --release

# --- Stage 2: Runtime ---
FROM alpine:3.19
RUN apk add --no-cache ca-certificates libstdc++
COPY --from=builder /build/app/target/release/rust-fullstack /usr/local/bin/server
EXPOSE 3002
CMD ["server"]
