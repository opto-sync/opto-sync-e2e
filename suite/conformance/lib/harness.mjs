/**
 * Zero-dependency assertion harness (node 22 built-ins only).
 *
 * Assertions RECORD rather than throw, so one bad expectation does not hide the
 * rest of a scenario's diagnostics. A case is failed by (a) any recorded
 * failure, or (b) an uncaught exception, which is captured and reported.
 *
 * `limitation()` records a WARN instead of a failure. It exists for behaviour
 * that is genuinely broken in the system under test but that we refuse to
 * either paper over (asserting the bug as correct hides a future fix) or fail
 * on (it is a reported, understood defect, not a regression). A resolved
 * limitation is printed loudly so the suite gets tightened.
 */
import { deepStrictEqual } from "node:assert";

const C = process.stdout.isTTY
  ? {
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      cyan: (s) => `\x1b[36m${s}\x1b[0m`,
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
    }
  : {
      red: (s) => s, green: (s) => s, yellow: (s) => s,
      cyan: (s) => s, dim: (s) => s, bold: (s) => s,
    };

/** Order-insensitive structural equality for objects, order-sensitive for arrays. */
export function canon(value) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v).sort().map((k) => [k, walk(v[k])])
      );
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

function preview(v, max = 220) {
  let s;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === undefined) s = String(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

class Recorder {
  constructor(caseName) {
    this.caseName = caseName;
    this.passed = 0;
    this.failures = [];
    this.warnings = [];
    this.notes = [];
  }

  _pass() {
    this.passed++;
    return true;
  }

  _fail(msg, detail) {
    this.failures.push({ msg, detail });
    return false;
  }

  /** Truthiness assertion. */
  ok(cond, msg) {
    return cond ? this._pass() : this._fail(msg, `expected truthy, got ${preview(cond)}`);
  }

  notOk(cond, msg) {
    return !cond ? this._pass() : this._fail(msg, `expected falsy, got ${preview(cond)}`);
  }

  /** Strict (===) equality. */
  eq(actual, expected, msg) {
    return actual === expected
      ? this._pass()
      : this._fail(msg, `expected ${preview(expected)}, got ${preview(actual)}`);
  }

  ne(actual, unexpected, msg) {
    return actual !== unexpected
      ? this._pass()
      : this._fail(msg, `expected value !== ${preview(unexpected)}`);
  }

  /** Deep structural equality (key order irrelevant — see jsonb notes). */
  deepEq(actual, expected, msg) {
    try {
      deepStrictEqual(actual, expected);
      return this._pass();
    } catch {
      return this._fail(
        msg,
        `deep-equal failed\n      expected: ${preview(expected, 400)}\n      actual:   ${preview(actual, 400)}`
      );
    }
  }

  /** HTTP status assertion; accepts a response wrapper from client.mjs. */
  status(res, expected, msg) {
    return res.status === expected
      ? this._pass()
      : this._fail(
          msg,
          `expected HTTP ${expected}, got ${res.status} — body: ${preview(res.body)}`
        );
  }

  /** Own-property presence (safe against inherited keys). */
  hasKey(obj, key, msg) {
    const present =
      obj != null && Object.prototype.hasOwnProperty.call(obj, key);
    return present
      ? this._pass()
      : this._fail(msg, `missing own key ${JSON.stringify(key)} in ${preview(obj)}`);
  }

  lacksKey(obj, key, msg) {
    const present =
      obj != null && Object.prototype.hasOwnProperty.call(obj, key);
    return !present
      ? this._pass()
      : this._fail(msg, `unexpected own key ${JSON.stringify(key)} in ${preview(obj)}`);
  }

  /** Substring containment (used for exact raw-jsonb text checks). */
  contains(haystack, needle, msg) {
    return String(haystack).includes(needle)
      ? this._pass()
      : this._fail(msg, `expected to contain ${preview(needle)} in ${preview(haystack, 300)}`);
  }

  omits(haystack, needle, msg) {
    return !String(haystack).includes(needle)
      ? this._pass()
      : this._fail(msg, `expected NOT to contain ${preview(needle)}`);
  }

  /**
   * Known, reported defect. `holds === true` means the defect is still present
   * (WARN); `false` means it appears fixed and the suite should be tightened.
   */
  limitation(holds, msg, detail) {
    if (holds) this.warnings.push({ msg, detail });
    else this.notes.push(`LIMITATION APPEARS RESOLVED — tighten this into an assertion: ${msg}`);
    return holds;
  }

  /** Free-form observation printed under the case. */
  info(msg) {
    this.notes.push(msg);
  }
}

/**
 * @param {Array<{name:string, cases:Array<{name:string, fn:Function}>}>} groups
 * @param {object} client
 */
export async function runGroups(groups, client) {
  const totals = { pass: 0, fail: 0, warn: 0, cases: 0, casesFailed: 0, groups: 0 };
  const failedCases = [];

  for (const group of groups) {
    totals.groups++;
    console.log(`\n${C.bold(C.cyan(`▶ ${group.name}`))}`);

    // Reset between scenario GROUPS for isolation. Individual cases that need a
    // pristine baseline call ctx.reset() themselves.
    try {
      await client.reset();
    } catch (err) {
      console.log(`  ${C.red("FAIL")} <group reset> — ${err.message}`);
      totals.fail++;
      totals.casesFailed++;
      failedCases.push(`${group.name} / <group reset>`);
      continue;
    }

    for (const testCase of group.cases) {
      totals.cases++;
      const rec = new Recorder(testCase.name);
      let thrown = null;
      const started = Date.now();
      try {
        await testCase.fn(rec, client);
      } catch (err) {
        thrown = err;
      }
      const ms = Date.now() - started;

      if (thrown) {
        rec.failures.push({
          msg: "uncaught exception",
          detail: thrown?.stack || String(thrown),
        });
      }

      totals.pass += rec.passed;
      totals.fail += rec.failures.length;
      totals.warn += rec.warnings.length;

      const ok = rec.failures.length === 0;
      if (!ok) {
        totals.casesFailed++;
        failedCases.push(`${group.name} / ${testCase.name}`);
      }

      const tag = ok ? C.green("PASS") : C.red("FAIL");
      const warnTag = rec.warnings.length ? C.yellow(` ${rec.warnings.length} warn`) : "";
      console.log(
        `  ${tag} ${testCase.name} ${C.dim(`(${rec.passed} assert${warnTag ? "," : ""}`)}${warnTag}${C.dim(`, ${ms}ms)`)}`
      );

      for (const note of rec.notes) console.log(`       ${C.dim("· " + note)}`);
      for (const w of rec.warnings) {
        console.log(`       ${C.yellow("⚠ " + w.msg)}`);
        if (w.detail) console.log(`         ${C.dim(w.detail)}`);
      }
      for (const f of rec.failures) {
        console.log(`       ${C.red("✗ " + f.msg)}`);
        if (f.detail) console.log(`         ${C.dim(f.detail)}`);
      }
    }
  }

  console.log(`\n${C.bold("═".repeat(64))}`);
  console.log(C.bold("  CONFORMANCE SUMMARY"));
  console.log(`${C.bold("═".repeat(64))}`);
  console.log(`  scenario groups : ${totals.groups}`);
  console.log(`  cases           : ${totals.cases} (${C.green(`${totals.cases - totals.casesFailed} passed`)}, ${totals.casesFailed ? C.red(`${totals.casesFailed} failed`) : "0 failed"})`);
  console.log(`  assertions      : ${C.green(`${totals.pass} passed`)}, ${totals.fail ? C.red(`${totals.fail} failed`) : "0 failed"}`);
  console.log(`  known-limitation warnings : ${totals.warn ? C.yellow(totals.warn) : 0}`);

  if (failedCases.length) {
    console.log(`\n  ${C.red("Failed cases:")}`);
    for (const name of failedCases) console.log(`    - ${name}`);
  }

  const verdict = totals.fail === 0 && totals.casesFailed === 0;
  console.log(
    `\n  ${verdict ? C.green(C.bold("RESULT: PASS")) : C.red(C.bold("RESULT: FAIL"))}\n`
  );
  return verdict;
}
