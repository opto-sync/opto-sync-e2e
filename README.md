# opto-sync-e2e

End-to-End distributed system tests for `opto-sync/syncer.c`.

This repository orchestrates a distributed test using real databases (AWS RDS PostgreSQL and Supabase) alongside multiple web servers and clients to validate the Zero-Deserialization JSONB merging architecture under real network conditions.

## Architecture
- **Servers**: 
  - Rust (Axum + SeaORM)
  - Node.js (Express/Fastify + Drizzle)
- **Clients**:
  - Dart FFI 
  - JS WASM
- **Databases**:
  - Supabase PostgreSQL
  - AWS RDS PostgreSQL
