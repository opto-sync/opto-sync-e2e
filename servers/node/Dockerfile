# --- Stage 1: Build ---
FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++ gcc

WORKDIR /build

# Copy syncer.c core for node-gyp compilation
COPY syncer.c/core/ /build/syncer-core/

# Copy TS binding
COPY syncer.c/bindings/typescript/ /build/syncer-ts/

# Copy the Node server source
COPY opto-sync-e2e/servers/node/ /build/app/
WORKDIR /build/app

# Fix binding.gyp: ../../core -> ../syncer-core (relative from /build/syncer-ts/)
RUN sed -i 's|../../core|../syncer-core|g' /build/syncer-ts/binding.gyp

# Fix the package.json dependency path to point to our copied syncer-ts
RUN sed -i 's|file:../../../syncer.c/bindings/typescript|file:../syncer-ts|g' package.json

# Install node-gyp globally and install dependencies (with native addon build)
RUN npm install -g node-gyp
RUN npm install --verbose

# Verify the native addon compiled
RUN ls -la node_modules/@opto-sync/syncer/build/Release/syncer.node || echo "WARN: native addon not found"

# --- Stage 2: Runtime ---
FROM node:22-alpine
RUN apk add --no-cache ca-certificates libstdc++
WORKDIR /app
COPY --from=builder /build/syncer-ts/ /syncer-ts/
COPY --from=builder /build/app/ /app/
EXPOSE 3003
CMD ["npx", "tsx", "src/index.ts"]
