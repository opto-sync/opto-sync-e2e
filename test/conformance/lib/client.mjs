/**
 * Thin HTTP client for the node e2e server. Zero dependencies — global fetch.
 *
 * Every helper returns `{ status, body, text }` rather than throwing on non-2xx,
 * because most conformance cases assert on the status itself (404/409/410/400).
 *
 * `*Raw` helpers send a caller-supplied body STRING rather than JSON.stringify-ing
 * an object. That matters for numeric fidelity tests: a JS number literal above
 * 2^53 is already truncated before it leaves the test process, so the only way to
 * put an exact int64 on the wire is to write the digits as text.
 */

const JSON_HEADERS = { "content-type": "application/json" };

export function createClient(baseUrl) {
  const base = baseUrl.replace(/\/+$/, "");

  async function request(path, init = {}) {
    const res = await fetch(base + path, init);
    const text = await res.text();
    let body;
    try {
      body = text.length ? JSON.parse(text) : null;
    } catch {
      body = null; // non-JSON (e.g. express' default HTML error page)
    }
    return { status: res.status, body, text, headers: res.headers };
  }

  /** Serialize per-request merge policy overrides (test mode only). */
  const optHeader = (options) =>
    options ? { "X-Syncer-Options": JSON.stringify(options) } : {};

  return {
    baseUrl: base,
    request,

    health: () => request("/health"),
    docs: () => request("/docs"),
    reset: async () => {
      const res = await request("/reset", { method: "POST" });
      if (res.status !== 200) {
        throw new Error(`/reset failed: HTTP ${res.status} ${res.text.slice(0, 200)}`);
      }
      return res;
    },

    getDoc: (id) => request(`/doc/${encodeURIComponent(id)}`),

    /** Exact stored jsonb text, as Postgres rendered it. */
    rawDoc: (id) => request(`/doc/${encodeURIComponent(id)}/raw`),

    putDoc: (id, data) =>
      request(`/doc/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify(data),
      }),

    putDocRaw: (id, bodyText) =>
      request(`/doc/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: bodyText,
      }),

    deleteDoc: (id) =>
      request(`/doc/${encodeURIComponent(id)}`, { method: "DELETE" }),

    /** Merge `payload` into a document. `{ options, noRetry }` are optional. */
    sync: (id, payload, { options, noRetry } = {}) =>
      request(`/doc/${encodeURIComponent(id)}/sync${noRetry ? "?noRetry=1" : ""}`, {
        method: "POST",
        headers: { ...JSON_HEADERS, ...optHeader(options) },
        body: JSON.stringify(payload),
      }),

    syncRaw: (id, bodyText, { options, noRetry, headers } = {}) =>
      request(`/doc/${encodeURIComponent(id)}/sync${noRetry ? "?noRetry=1" : ""}`, {
        method: "POST",
        headers: { ...JSON_HEADERS, ...optHeader(options), ...headers },
        body: bodyText,
      }),

    batch: (mutations, { options } = {}) =>
      request("/sync/batch", {
        method: "POST",
        headers: { ...JSON_HEADERS, ...optHeader(options) },
        body: JSON.stringify({ mutations }),
      }),

    batchRaw: (bodyText) =>
      request("/sync/batch", {
        method: "POST",
        headers: JSON_HEADERS,
        body: bodyText,
      }),

    profileSync: (payload, { options } = {}) =>
      request("/profile/sync", {
        method: "POST",
        headers: { ...JSON_HEADERS, ...optHeader(options) },
        body: JSON.stringify(payload),
      }),

    getProfile: (email) => request(`/profile/${encodeURIComponent(email)}`),

    /** Convenience: fetch just the merged `data` of a document. */
    async data(id) {
      const res = await request(`/doc/${encodeURIComponent(id)}`);
      return res.body?.data;
    },

    /** Convenience: fetch just the version of a document. */
    async version(id) {
      const res = await request(`/doc/${encodeURIComponent(id)}`);
      return res.body?.version;
    },
  };
}

/** Poll /health until the server answers, or give up after ~timeoutMs. */
export async function waitForHealth(baseUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "no attempt made";
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) return await res.json();
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err?.message ?? String(err);
    }
    if (attempt === 1 || attempt % 5 === 0) {
      console.log(`  waiting for ${baseUrl}/health … (${lastErr})`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `server at ${baseUrl} not healthy after ${timeoutMs}ms (last error: ${lastErr})`
  );
}
