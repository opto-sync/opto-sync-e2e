/**
 * Scenario 4 — jsonb round-trip fidelity, inspected through /doc/:id/raw.
 *
 * ── Why byte-identity is the WRONG assertion ──────────────────────────────
 * Postgres `jsonb` is a parsed, normalized representation, not stored text. It
 * does NOT preserve object key insertion order (it sorts keys by length, then
 * bytewise), it drops insignificant whitespace, and it collapses duplicate keys.
 * So a document written as {"zzz":1,"aaa":2} comes back as {"aaa": 2, "zzz": 1}.
 *
 * Therefore every fidelity assertion here compares the SEMANTIC value
 * (deep-equal after JSON.parse), and separately asserts that the byte order did
 * in fact change — because if it ever stopped changing, this suite's premise
 * would be wrong and the comparisons would be silently weaker than intended.
 *
 * ── Numeric precision ─────────────────────────────────────────────────────
 * Values above 2^53-1 (Number.MAX_SAFE_INTEGER = 9007199254740991) cannot
 * survive this server as JSON *numbers*. The loss is NOT in Postgres and NOT in
 * the C core:
 *
 *   - Postgres jsonb stores JSON numbers as `numeric` (arbitrary precision):
 *       SELECT '{"ns":1689940800123456789}'::jsonb::text
 *       -> {"ns": 1689940800123456789}     (exact)
 *   - the C core parses/serializes via yyjson, which is int64-exact.
 *   - the node server round-trips every payload through JavaScript
 *     (express.json -> JSON.parse -> double -> JSON.stringify), and a JS double
 *     cannot hold 1689940800123456789. It becomes 1689940800123456800.
 *
 * That truncation is recorded as a `limitation()` (a WARN, not a pass and not a
 * failure) so a future fix surfaces instead of being locked in by a green test.
 * The supported way to carry nanosecond precision through this server is a JSON
 * string, which is also what the core's timestamp comparator handles natively
 * (pure-digit strings compare numerically) — asserted below.
 */

const NANO = "1689940800123456789"; // 19 digits, > 2^53
const MAX_SAFE = "9007199254740991"; // 2^53 - 1

export default {
  name: "4. jsonb round-trip fidelity (/doc/:id/raw)",
  cases: [
    {
      name: "jsonb reorders keys but the SEMANTIC value survives deep-equal",
      async fn(t, c) {
        await c.reset();
        // Deliberately hostile insertion order: reverse-alphabetical, mixed key
        // lengths, so jsonb's (length, bytes) ordering must differ from ours.
        const payload = {
          zzz: 1,
          aaa: 2,
          mmm: 3,
          bb: 4,
          dddd: 5,
          nested: { yyy: "y", ax: "a", cccc: "c" },
        };
        const written = JSON.stringify(payload);
        await c.putDoc("fidelity", payload);

        const raw = await c.rawDoc("fidelity");
        t.status(raw, 200, "GET /doc/:id/raw responds 200");

        // The premise of this whole scenario: byte order DID change.
        t.ne(
          raw.text,
          written,
          "stored jsonb text is NOT byte-identical to what we wrote (keys reordered)"
        );
        t.deepEq(
          JSON.parse(raw.text),
          payload,
          "…yet the parsed value is deep-equal: semantics survive, byte order does not"
        );

        // Prove the reordering is real and is jsonb's documented (len, bytes) rule.
        const topKeys = Object.keys(JSON.parse(raw.text));
        t.deepEq(
          topKeys,
          ["bb", "aaa", "mmm", "zzz", "dddd", "nested"],
          "jsonb key order is by key length, then bytewise"
        );
        t.deepEq(
          Object.keys(JSON.parse(raw.text).nested),
          ["ax", "cccc", "yyy"],
          "nested objects are reordered by the same rule"
        );
      },
    },
    {
      name: "int64 nanosecond timestamps: exact through jsonb, truncated by the JS layer",
      async fn(t, c) {
        await c.reset();
        // Raw TEXT body: a JS number literal here would already be truncated
        // inside this test process before it ever reached the server.
        await c.putDocRaw("nsdoc", `{"ns":${NANO},"nested":{"ns2":${NANO}},"safe":${MAX_SAFE}}`);
        const raw = await c.rawDoc("nsdoc");
        t.status(raw, 200, "raw fetch of the nanosecond doc succeeds");

        // 2^53-1 is representable and MUST survive exactly.
        t.contains(raw.text, MAX_SAFE, `Number.MAX_SAFE_INTEGER (${MAX_SAFE}) survives exactly`);

        const exact = raw.text.includes(NANO);
        t.limitation(
          !exact,
          `int64 nanosecond timestamp ${NANO} does NOT survive as a JSON number (got ${
            JSON.parse(raw.text).ns
          })`,
          "Cause: the node server round-trips payloads through JavaScript numbers " +
            "(express.json JSON.parse -> double -> JSON.stringify). Postgres jsonb and " +
            "the C core are both exact. Workaround: send nanosecond values as JSON strings."
        );
        if (exact) {
          t.contains(raw.text, NANO, "nanosecond int64 survives exactly as a number");
        }
      },
    },
    {
      name: "nanosecond precision DOES survive when carried as a JSON string",
      async fn(t, c) {
        await c.reset();
        await c.sync("doc-1", { nsStr: NANO, nested: { nsStr2: NANO } });
        const raw = await c.rawDoc("doc-1");
        t.contains(raw.text, `"${NANO}"`, "19-digit value survives byte-exact as a string");
        const d = JSON.parse(raw.text);
        t.eq(d.nsStr, NANO, "string-carried nanosecond value is exactly preserved");
        t.eq(d.nested.nsStr2, NANO, "…including when nested");
      },
    },
    {
      name: "digit-string timestamps still resolve LWW correctly (nanosecond-safe conflicts)",
      async fn(t, c) {
        await c.reset();
        // The core compares pure-digit strings numerically, so string-carried
        // nanosecond stamps remain usable for conflict resolution.
        await c.putDoc("nsrows", {
          rows: [{ id: "r1", updatedAt: "1689940800123456789", v: "base" }],
        });
        await c.sync("nsrows", {
          rows: [{ id: "r1", updatedAt: "1689940800123456788", v: "STALE-by-1ns" }],
        });
        let r = (await c.data("nsrows")).rows[0];
        t.eq(r.v, "base", "a value 1 nanosecond older is rejected (digit strings compare numerically)");

        await c.sync("nsrows", {
          rows: [{ id: "r1", updatedAt: "1689940800123456790", v: "FRESH-by-1ns" }],
        });
        r = (await c.data("nsrows")).rows[0];
        t.eq(r.v, "FRESH-by-1ns", "a value 1 nanosecond newer is accepted");
        t.eq(r.updatedAt, "1689940800123456790", "nanosecond stamp stored without precision loss");
      },
    },
    {
      name: "unicode keys and values survive the round trip",
      async fn(t, c) {
        await c.reset();
        const payload = {
          "ключ": "значение",
          "日本語": "テスト",
          "emoji🔑": "value😀🎉",
          "combining-é": "café́",
          "quote\"key": "back\\slash",
          "tab\tkey": "new\nline",
          nested: { "🇺🇳": { "مفتاح": "قيمة" } },
        };
        await c.putDoc("unicode", payload);
        const raw = await c.rawDoc("unicode");
        t.deepEq(
          JSON.parse(raw.text),
          payload,
          "unicode keys and values (cyrillic, CJK, emoji, RTL, escapes) survive deep-equal"
        );
        const d = JSON.parse(raw.text);
        t.eq(d["emoji🔑"], "value😀🎉", "astral-plane emoji preserved in both key and value");
        t.eq(d.nested["🇺🇳"]["مفتاح"], "قيمة", "RTL text preserved in a nested key");
        t.eq(d["tab\tkey"], "new\nline", "control characters preserved");
      },
    },
    {
      name: "deeply nested structures survive (40 levels) and merge at depth",
      async fn(t, c) {
        await c.reset();
        const DEPTH = 40;
        let deep = { bottom: "reached" };
        for (let i = DEPTH; i > 0; i--) deep = { [`L${i}`]: deep };

        await c.putDoc("deepdoc", deep);
        const raw = await c.rawDoc("deepdoc");
        t.deepEq(JSON.parse(raw.text), deep, `${DEPTH}-level nesting survives deep-equal`);

        // Walk down to confirm the structure is genuinely intact.
        let cursor = JSON.parse(raw.text);
        let ok = true;
        for (let i = 1; i <= DEPTH; i++) {
          cursor = cursor?.[`L${i}`];
          if (!cursor) { ok = false; break; }
        }
        t.ok(ok, `all ${DEPTH} levels are individually traversable`);
        t.eq(cursor?.bottom, "reached", "the deepest leaf is intact");

        // And a merge can still reach the bottom.
        let patch = { alsoAtBottom: true };
        for (let i = DEPTH; i > 0; i--) patch = { [`L${i}`]: patch };
        await c.sync("deepdoc", patch);
        let cur = await c.data("deepdoc");
        for (let i = 1; i <= DEPTH; i++) cur = cur?.[`L${i}`];
        t.eq(cur?.bottom, "reached", "original deep leaf survives a deep merge");
        t.eq(cur?.alsoAtBottom, true, "merge added a sibling at 40 levels down");
      },
    },
    {
      name: "large arrays survive (2000 keyed objects) with order and content intact",
      async fn(t, c) {
        await c.reset();
        const N = 2000;
        const rows = Array.from({ length: N }, (_, i) => ({
          id: `r${i}`,
          n: i,
          label: `row-${i}`,
        }));
        await c.putDoc("bigarr", { rows });

        const raw = await c.rawDoc("bigarr");
        const parsed = JSON.parse(raw.text);
        t.eq(parsed.rows.length, N, `all ${N} array elements survive`);
        t.deepEq(parsed.rows, rows, "large array is deep-equal, element order preserved");
        t.deepEq(parsed.rows[0], { id: "r0", n: 0, label: "row-0" }, "first element intact");
        t.deepEq(
          parsed.rows[N - 1],
          { id: `r${N - 1}`, n: N - 1, label: `row-${N - 1}` },
          "last element intact"
        );

        // Reconcile a single element deep inside the large array.
        await c.sync("bigarr", { rows: [{ id: "r1999", label: "PATCHED" }] });
        const after = (await c.data("bigarr")).rows;
        t.eq(after.length, N, "keyed merge into a large array did not change its length");
        t.eq(after[N - 1].label, "PATCHED", "the targeted element was updated in place");
        t.eq(after[N - 1].n, N - 1, "its untouched sibling field survived");
        t.eq(after[0].label, "row-0", "unrelated elements untouched");
      },
    },
    {
      name: "mixed scalar types and float/negative/zero values survive",
      async fn(t, c) {
        await c.reset();
        const payload = {
          t: true,
          f: false,
          z: 0,
          negZeroIsh: -0.0,
          neg: -42,
          float: 1.5,
          sci: 1.25e10,
          small: 0.000001,
          nul: null,
          emptyStr: "",
          arr: [1, "two", true, null, { k: "v" }, [1, 2]],
        };
        await c.putDoc("scalars", payload);
        const parsed = JSON.parse((await c.rawDoc("scalars")).text);
        t.eq(parsed.t, true, "true survives");
        t.eq(parsed.f, false, "false survives");
        t.eq(parsed.z, 0, "zero survives");
        t.eq(parsed.neg, -42, "negative integer survives");
        t.eq(parsed.float, 1.5, "float survives");
        t.eq(parsed.sci, 1.25e10, "scientific notation survives numerically");
        t.eq(parsed.small, 0.000001, "small float survives");
        t.eq(parsed.nul, null, "null survives");
        t.eq(parsed.emptyStr, "", "empty string survives");
        t.deepEq(
          parsed.arr,
          [1, "two", true, null, { k: "v" }, [1, 2]],
          "heterogeneous array (incl. nested object and array) survives"
        );
      },
    },
  ],
};
