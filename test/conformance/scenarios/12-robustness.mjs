/**
 * Scenario 12 — robustness: malformed input, missing resources, very large
 * payloads, and prototype pollution.
 *
 * The bar is "predictable client-visible failure", i.e. a 4xx that a client can
 * act on, never a 500 and never a corrupted document.
 */

const MB = 1024 * 1024;

export default {
  name: "12. Robustness & prototype pollution",
  cases: [
    {
      name: "malformed JSON body -> 400 (not 500)",
      async fn(t, c) {
        for (const body of ["{not json", "{", "{\"a\":}", "[1,", '{"a":1,}']) {
          const res = await c.syncRaw("doc-1", body);
          t.eq(
            res.status,
            400,
            `malformed body ${JSON.stringify(body)} -> 400 (got ${res.status})`
          );
        }
      },
    },
    {
      name: "non-object JSON bodies are rejected with 400",
      async fn(t, c) {
        const cases = [
          ["array", "[1,2,3]"],
          ["string", '"hello"'],
          ["number", "42"],
          ["null", "null"],
          ["boolean", "true"],
        ];
        for (const [label, body] of cases) {
          const res = await c.syncRaw("doc-1", body);
          t.eq(res.status, 400, `top-level ${label} body -> 400 (got ${res.status})`);
        }
        // …and a valid object still works, proving the above is not a blanket reject.
        t.status(await c.syncRaw("doc-1", '{"ok":true}'), 200, "a valid object body -> 200");
      },
    },
    {
      name: "the request schema enforces types on its known fields (400, with details)",
      async fn(t, c) {
        await c.reset();
        // The server declares title:string, metadata/settings:object,
        // updatedAt/syncedAt/createdAt:string|number, and passes everything else
        // through untyped. A wrongly-typed KNOWN field is a 400, not a merge.
        const bad = [
          ["title as object", { title: { not: "a string" } }],
          ["title as number", { title: 42 }],
          ["metadata as string", { metadata: "not-an-object" }],
          ["settings as array", { settings: [1, 2] }],
          ["updatedAt as object", { updatedAt: { t: 1 } }],
          ["updatedAt as boolean", { updatedAt: true }],
        ];
        for (const [label, payload] of bad) {
          const res = await c.sync("doc-1", payload);
          t.eq(res.status, 400, `${label} -> 400 (got ${res.status})`);
        }
        const withDetails = await c.sync("doc-1", { title: 42 });
        t.ok(withDetails.body?.details != null, "400 body includes validation details");

        // Unknown fields of ANY type pass through untouched.
        const ok = await c.sync("doc-1", {
          anythingGoes: { deeply: [1, { nested: true }] },
          alsoFine: 3.14,
        });
        t.status(ok, 200, "unknown fields of any type are accepted (passthrough)");
        t.deepEq(
          (await c.data("doc-1")).anythingGoes,
          { deeply: [1, { nested: true }] },
          "passthrough field stored intact"
        );
        t.eq(
          (await c.data("doc-1")).title,
          "Project Alpha",
          "the rejected requests never modified the document"
        );
      },
    },
    {
      name: "a rejected body does not modify the document",
      async fn(t, c) {
        await c.reset();
        const before = await c.data("doc-1");
        await c.syncRaw("doc-1", "{not json");
        await c.syncRaw("doc-1", "[1,2,3]");
        t.deepEq(await c.data("doc-1"), before, "document untouched by rejected requests");
        t.eq(await c.version("doc-1"), 1, "version did not advance on rejected requests");
      },
    },
    {
      name: "unknown document -> 404 on every read/write path",
      async fn(t, c) {
        t.status(await c.getDoc("ghost"), 404, "GET /doc/ghost -> 404");
        t.status(await c.rawDoc("ghost"), 404, "GET /doc/ghost/raw -> 404");
        t.status(await c.sync("ghost", { a: 1 }), 404, "POST /doc/ghost/sync -> 404");
        t.status(await c.deleteDoc("ghost"), 404, "DELETE /doc/ghost -> 404");
        const res = await c.getDoc("ghost");
        t.ok(
          typeof res.body?.error === "string",
          "404 responses carry a JSON error message"
        );
      },
    },
    {
      name: "document ids with URL-significant characters are handled",
      async fn(t, c) {
        const id = "weird id/with?chars&and=stuff";
        const put = await c.putDoc(id, { ok: true });
        t.status(put, 200, "PUT with an encoded exotic id succeeds");
        t.status(await c.getDoc(id), 200, "GET round-trips the exotic id");
        t.eq((await c.data(id)).ok, true, "data stored under the exotic id");
        await c.sync(id, { merged: 1 });
        t.eq((await c.data(id)).merged, 1, "sync works on the exotic id");
      },
    },
    {
      name: "a ~5MB payload succeeds and round-trips intact",
      async fn(t, c) {
        await c.reset();
        const blob = "x".repeat(5 * MB);
        const res = await c.sync("doc-1", { blob, marker: "big" });
        t.status(res, 200, "5MB payload accepted (server limit is 32mb)");

        const d = await c.data("doc-1");
        t.eq(d.blob?.length, 5 * MB, "the 5MB string round-tripped at full length");
        t.eq(d.marker, "big", "sibling field in the large payload landed");
        t.eq(d.title, "Project Alpha", "pre-existing fields survived the large merge");
        t.ok(
          d.blob === blob,
          "the 5MB value is byte-identical after the jsonb round trip"
        );
      },
    },
    {
      name: "a payload with many keys and a wide array succeeds",
      async fn(t, c) {
        await c.reset();
        const wide = {};
        for (let i = 0; i < 2000; i++) wide[`key_${i}`] = i;
        const res = await c.sync("doc-1", { wide, list: Array.from({ length: 5000 }, (_, i) => i) });
        t.status(res, 200, "2000-key object + 5000-element array accepted");
        const d = await c.data("doc-1");
        t.eq(Object.keys(d.wide).length, 2000, "all 2000 keys stored");
        t.eq(d.wide.key_1999, 1999, "last key has the right value");
        t.eq(d.list.length, 5000, "5000-element array stored");
        t.eq(d.list[4999], 4999, "last array element intact");
      },
    },
    {
      name: "__proto__ / constructor / prototype in a payload cause NO prototype pollution",
      async fn(t, c) {
        await c.reset();
        const res = await c.syncRaw(
          "doc-1",
          JSON.stringify({
            __proto__: { polluted: "YES" },
            constructor: { bad: 1 },
            prototype: { p: 1 },
            normal: "ok",
          })
        );
        t.status(res, 200, "payload with polluting keys is accepted (they are just data)");

        // The critical assertions: nothing leaked onto Object.prototype in THIS
        // process while parsing the server's response.
        t.eq({}.polluted, undefined, "Object.prototype was not polluted via a fresh object");
        t.eq(Object.prototype.polluted, undefined, "Object.prototype has no `polluted` key");
        t.eq({}.bad, undefined, "no `bad` key leaked onto Object.prototype");
        t.eq({}.p, undefined, "no `p` key leaked onto Object.prototype");
        t.eq(
          Object.getPrototypeOf({}),
          Object.prototype,
          "the Object prototype chain is intact"
        );

        const d = await c.data("doc-1");
        t.eq(d.normal, "ok", "the benign field in the same payload landed");
        t.eq(
          Object.getPrototypeOf(d),
          Object.prototype,
          "the parsed document's prototype is the ordinary Object.prototype"
        );
        t.eq(d.polluted, undefined, "the document did not inherit `polluted`");

        // `constructor`/`prototype` survive as ORDINARY data keys, which is
        // correct: they are only dangerous if something assigns them onto an
        // object, and JSON.parse creates own properties instead.
        t.hasKey(d, "constructor", "`constructor` is stored as an own data key");
        t.deepEq(d.constructor, { bad: 1 }, "`constructor` holds the submitted value, not a function");
        t.hasKey(d, "prototype", "`prototype` is stored as an own data key");
        t.eq(typeof d.constructor, "object", "`constructor` did not shadow the real constructor fn");

        const raw = await c.rawDoc("doc-1");
        t.contains(raw.text, '"constructor"', "`constructor` is present in the stored jsonb");
        // On the /doc/:id/sync path the request schema rebuilds the object by
        // assignment, so a literal `__proto__` key is silently dropped rather
        // than stored. Documented here because the batch path differs.
        t.omits(
          raw.text,
          '"__proto__"',
          "`__proto__` does not reach storage on the /sync path (dropped by the request schema)"
        );
      },
    },
    {
      name: "__proto__ through the BATCH path is stored as inert data, still no pollution",
      async fn(t, c) {
        await c.reset();
        // /sync/batch does not run payloads through the request schema, so the
        // key survives to storage. It must remain inert data.
        const res = await c.batchRaw(
          '{"mutations":[{"docId":"doc-1","payload":{"__proto__":{"polluted":"YES"},"k":"v"}}]}'
        );
        t.status(res, 200, "batch with a __proto__ key is accepted");
        t.eq(res.body?.applied, 1, "the mutation applied");

        t.eq({}.polluted, undefined, "Object.prototype still not polluted");
        t.eq(Object.prototype.polluted, undefined, "no `polluted` on Object.prototype");

        const raw = await c.rawDoc("doc-1");
        t.contains(raw.text, '"__proto__"', "via batch, `__proto__` IS stored (as inert jsonb data)");

        const d = await c.data("doc-1");
        t.eq(d.k, "v", "the benign field landed");
        t.eq(
          Object.getPrototypeOf(d),
          Object.prototype,
          "the parsed document still has an ordinary prototype (JSON.parse makes own props)"
        );
        t.ok(
          Object.prototype.hasOwnProperty.call(d, "__proto__"),
          "`__proto__` came back as an OWN property, not as the object's prototype"
        );
        t.deepEq(
          Object.getOwnPropertyDescriptor(d, "__proto__")?.value,
          { polluted: "YES" },
          "its value is plain data"
        );
      },
    },
    {
      name: "unsupported methods and unknown routes do not 500",
      async fn(t, c) {
        const unknown = await c.request("/no/such/route");
        t.eq(unknown.status, 404, `unknown route -> 404 (got ${unknown.status})`);
        const badMethod = await c.request("/health", { method: "DELETE" });
        t.ok(
          badMethod.status >= 400 && badMethod.status < 500,
          `DELETE /health -> 4xx, not 5xx (got ${badMethod.status})`
        );
      },
    },
    {
      name: "an empty request body is handled without a 500",
      async fn(t, c) {
        const res = await c.request("/doc/doc-1/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "",
        });
        t.ok(
          res.status === 200 || (res.status >= 400 && res.status < 500),
          `empty body -> 200 or 4xx, never 5xx (got ${res.status})`
        );
        const noCt = await c.request("/doc/doc-1/sync", { method: "POST", body: "{}" });
        t.ok(
          noCt.status < 500,
          `missing content-type -> non-5xx (got ${noCt.status})`
        );
      },
    },
    {
      name: "the server is still healthy and consistent after the abuse above",
      async fn(t, c) {
        const h = await c.health();
        t.status(h, 200, "server still healthy");
        t.eq(h.body?.syncer, "native", "still running the native core");
        await c.reset();
        const docs = await c.docs();
        t.eq((docs.body ?? []).length, 4, "reset still restores exactly the 4 seed docs");
        t.ok(
          (docs.body ?? []).every((d) => d.data && typeof d.data === "object"),
          "every seed document has valid object data"
        );
      },
    },
  ],
};
