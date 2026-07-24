# --- Stage 1: Build ---
FROM rust:1.79-alpine AS builder
RUN apk add --no-cache musl-dev gcc make

WORKDIR /build

# Copy syncer.c core and Rust binding
COPY syncer.c/core/ /build/syncer-core/
COPY syncer.c/bindings/rust/ /build/syncer-rs/

# Copy the fullstack server source
COPY opto-sync-e2e/servers/rust-fullstack/ /build/app/
WORKDIR /build/app

# Fix the syncer-rs dependency path in Cargo.toml
RUN sed -i 's|../../../syncer.c/bindings/rust|../syncer-rs|g' Cargo.toml

# Fix the syncer-rs build.rs to use the relative path to the C core
# (relative from /build/syncer-rs/ to /build/syncer-core/ = ../syncer-core)
RUN sed -i 's|../../core|../syncer-core|g' /build/syncer-rs/build.rs

RUN cargo build --release

# --- Stage 2: Runtime ---
FROM alpine:3.19
RUN apk add --no-cache ca-certificates libstdc++
COPY --from=builder /build/app/target/release/rust-fullstack /usr/local/bin/server
EXPOSE 3002
CMD ["server"]
