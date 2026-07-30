# --- Stage 1: Build ---
FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++ gcc

WORKDIR /build

# Copy syncer.c core for node-gyp compilation
COPY syncer.c/core/ /build/syncer-core/

# Copy TS binding
COPY syncer.c/bindings/typescript/ /build/syncer-ts/

RUN mkdir /build/app
COPY opto-sync-e2e/servers/node/package.json /build/app/package.json
COPY opto-sync-e2e/servers/node/package-lock.json /build/app/package-lock.json
WORKDIR /build/app

# Fix binding.gyp: ../../core -> ../syncer-core (relative from /build/syncer-ts/)
RUN sed -i 's|../../core|../syncer-core|g' /build/syncer-ts/binding.gyp

# Fix the package.json dependency path to point to our copied syncer-ts.
# Resolve the rewritten local dependency fresh inside the image. Copying only
# package.json here keeps this expensive layer cached when server source/tests
# change but dependency manifests and the native core do not.
RUN sed -i 's|../../../syncer.c/bindings/typescript|../syncer-ts|g' \
    package.json package-lock.json

# Install node-gyp globally and install dependencies (with native addon build)
RUN npm install -g node-gyp
# The binding's install script (node-gyp rebuild) runs inside /build/syncer-ts,
# where the app-level hoisted node_modules is not on the resolution path — so
# node-addon-api must be installed locally there first.
RUN cd /build/syncer-ts && npm install --no-audit --no-fund
RUN npm ci --verbose

# Source changes should invalidate typechecking/runtime layers, not dependency
# installation or the native addon build above.
COPY opto-sync-e2e/servers/node/tsconfig.json /build/app/tsconfig.json
COPY opto-sync-e2e/servers/node/tsconfig.build.json /build/app/tsconfig.build.json
COPY opto-sync-e2e/servers/node/src/ /build/app/src/
RUN npm run typecheck
RUN npm run build
RUN npm prune --omit=dev

# Verify the native addon compiled
RUN ls -la node_modules/@opto-sync/syncer/build/Release/syncer.node || echo "WARN: native addon not found"

# --- Stage 2: Runtime ---
FROM node:22-alpine
RUN apk add --no-cache ca-certificates libstdc++
WORKDIR /app
COPY --from=builder /build/syncer-ts/ /syncer-ts/
COPY --from=builder /build/app/package.json /build/app/package-lock.json /app/
COPY --from=builder /build/app/dist/ /app/dist/
COPY --from=builder /build/app/node_modules/ /app/node_modules/
EXPOSE 3003
CMD ["node", "dist/index.js"]
