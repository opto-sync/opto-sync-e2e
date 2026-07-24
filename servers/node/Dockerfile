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

# Fix path to local native addon
RUN sed -i 's|../../../syncer.c/bindings/typescript|../syncer-ts|g' package.json

# Fix the path inside the addon's binding.gyp
RUN sed -i 's|../../core|../syncer-core|g' ../syncer-ts/binding.gyp

# Install node-gyp globally and install dependencies (with native addon build)
RUN npm install -g node-gyp
RUN npm install --verbose

# --- Stage 2: Runtime ---
FROM node:22-alpine
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=builder /build/app/ /app/
EXPOSE 3003
CMD ["npx", "tsx", "src/index.ts"]
