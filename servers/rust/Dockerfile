# --- Stage 1: Build ---
FROM rust:alpine AS builder
RUN apk add --no-cache musl-dev gcc make pkgconfig openssl-dev openssl-libs-static

WORKDIR /build

# Copy syncer.c core
COPY syncer.c/core/ /build/syncer-core/

# Copy Rust binding
COPY syncer.c/bindings/rust/ /build/syncer-rs/

# Copy the server source
COPY opto-sync-e2e/servers/rust/ /build/app/

# Fix paths for Docker environment
WORKDIR /build/app
RUN sed -i 's|../../../syncer.c/bindings/rust|../syncer-rs|g' Cargo.toml
RUN sed -i 's|../../core|../syncer-core|g' ../syncer-rs/build.rs
RUN cargo build --release

# --- Stage 2: Runtime ---
FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=builder /build/app/target/release/rust-server /usr/local/bin/server
EXPOSE 3001
CMD ["server"]
