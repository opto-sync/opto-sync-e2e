# Functional programming conformance

This repository is checked against the house functional-programming guidelines.
Functional programming here means nine specific things:

- **explicit inputs** — what a function needs arrives through its parameters
- **explicit outputs** — what a function produces leaves through its return type
- **immutable values** — bindings and fields do not change after construction
- **pure transformations** — same input, same output, no observable effect
- **typed errors** — failure is a value in the signature, not an escape
- **explicit state transitions** — state changes are named and returned
- **composition** — small named steps combined, rather than one long body
- **effects pushed outward** — I/O, clocks, randomness and logging live at the edge
- **illegal states excluded by types** — the compiler rejects what must not happen

Stateful code is not exempt from all of this. Websocket handlers, TCP
connections, stateful clients and actor loops legitimately hold mutable state, and
the scanner relaxes the mutability rules for modules whose path marks them as such
(`ws/`, `socket/`, `conn/`, `session/`, `pool/`, `cache/`, `stream/`, `actor/`,
`fsm/`, `state_machine/`). Everything else — typed errors, exhaustive matching,
composition, effects at the edge — still applies there. Likewise, modules that
*are* the outward edge (`main`, `bin/`, `effects/`, `io/`, `adapters/`, `infra/`,
`transport/`, `handlers/`, `routes/`, `db/`, `telemetry/`) are allowed to perform
effects: that is the point of pushing effects outward.

## Running the check

```sh
python3 tools/fp-conformance/fp_conformance.py .                    # report
python3 tools/fp-conformance/fp_conformance.py . --limit 200        # more detail
python3 tools/fp-conformance/fp_conformance.py . --json /tmp/fp.json
```

Stdlib Python 3 only — no toolchain, no dependencies, no network — so it runs
identically on a laptop and on a CI runner.

## The budget, and why CI is not red today

`tools/fp-conformance/budget.json` records the per-rule counts at the moment this
check was introduced: **289 findings across 18 files
and 7,097 lines**. CI compares against that budget and fails only when a
rule's count *increases*. The existing backlog blocks nobody; new violations do.

The budget is a ratchet. It should only ever move down. When you clear a class of
violation, re-baseline in the same commit as the fix:

```sh
python3 tools/fp-conformance/fp_conformance.py . \
    --write-budget tools/fp-conformance/budget.json
```

Raising the budget to turn CI green defeats the whole mechanism. Fix the code.

## Baseline for this repository

| rule | count | severity | principle | what it flags |
|---|---:|---|---|---|
| `RS003` | 74 | error | typed errors | panic-based control flow (`unwrap`/`expect`/`panic!`) |
| `TS006` | 50 | warn | typed errors | `throw` as control flow |
| `TS005` | 26 | warn | explicit inputs | `any` escapes the type system |
| `TS002` | 19 | warn | immutable values | mutable `let` binding |
| `TS008` | 18 | warn | effects pushed outward | direct console effect in library code |
| `TS009` | 15 | warn | explicit inputs | ambient impurity (clock / randomness / env) read inside pure code |
| `DA005` | 14 | warn | typed errors | `throw` as control flow |
| `RS001` | 13 | warn | immutable values | mutable local binding (`let mut`) |
| `TS004` | 13 | warn | pure transformations | in-place array mutation |
| `XX002` | 9 | warn | explicit outputs | long function body |
| `DA003` | 8 | warn | immutable values | mutable (non-`final`) instance field |
| `DA001` | 7 | warn | immutable values | `var` binding instead of `final` |
| `DA008` | 4 | warn | pure transformations | in-place collection mutation |
| `TS003` | 4 | error | explicit state transitions | module-level mutable binding |
| `XX001` | 4 | warn | composition | oversized module |
| `RS008` | 3 | warn | explicit outputs | `&mut self` method returning unit |
| `TS010` | 3 | warn | illegal states excluded by types | non-null assertion (`!`) suppresses a real case |
| `DA004` | 2 | warn | immutable values | `late` non-final binding |
| `RS009` | 2 | error | illegal states excluded by types | `unsafe` block |
| `RS004` | 1 | warn | illegal states excluded by types | wildcard match arm defeats exhaustiveness |

## How to clear the top offenders

### `RS003` — panic-based control flow (`unwrap`/`expect`/`panic!`)

*typed errors* · 74 occurrences at baseline

Return `Result<T, E>` with a domain error enum and propagate with `?`; reserve panics for genuinely unreachable invariants proven by types.

### `TS006` — `throw` as control flow

*typed errors* · 50 occurrences at baseline

Return a discriminated `Result`/`Either` so the failure appears in the signature instead of escaping it.

### `TS005` — `any` escapes the type system

*explicit inputs* · 26 occurrences at baseline

Give the value a real type, or `unknown` plus a narrowing guard, so illegal states stay excluded by types.

### `TS002` — mutable `let` binding

*immutable values* · 19 occurrences at baseline

Prefer `const`. Where a value genuinely evolves, derive it with `reduce`/`map` or model the transition explicitly.

### `TS008` — direct console effect in library code

*effects pushed outward* · 18 occurrences at baseline

Route through the ores-otel logger so the effect is observable and lives at the boundary.

### `TS009` — ambient impurity (clock / randomness / env) read inside pure code

*explicit inputs* · 15 occurrences at baseline

Take the value as a parameter — inject a clock, a seeded RNG, or a config object — so the function stays testable and deterministic.

### `DA005` — `throw` as control flow

*typed errors* · 14 occurrences at baseline

Return a sealed `Result` union so the failure is part of the signature and the switch over it stays exhaustive.

### `RS001` — mutable local binding (`let mut`)

*immutable values* · 13 occurrences at baseline

Rebind with `let`, fold with an iterator, or build the value with `collect()`/`fold()` instead of mutating in place.

### `TS004` — in-place array mutation

*pure transformations* · 13 occurrences at baseline

Use the copying form — spread, `toSorted`, `toReversed`, `concat`, `filter` — so callers' values are not modified.

### `XX002` — long function body

*explicit outputs* · 9 occurrences at baseline

A body over 60 lines is usually several transformations. Extract named, individually testable steps and compose them.

## Assurance boundary and language-native enforcement

The Python scanner is a portable lexical ratchet. It can prevent the currently
recognized source patterns from increasing, including Rust wildcard arms and
Dart `default:` arms. It does **not** parse either language, prove that a match
is exhaustive, establish state-machine invariants, or replace compilation,
model checking, trace replay, and runtime tests.

The remaining type-level rollout belongs to each toolchain and must be enabled
in the repositories that own those sources:

- **Rust** — deny wildcard enum arms where they weaken a closed state machine,
  and run formatting, Clippy, and tests on every target.
- **TypeScript** — use discriminated unions plus an `assertNever` boundary and
  enable `@typescript-eslint/switch-exhaustiveness-check` in typed ESLint.
- **Dart** — use sealed types or enums, omit catch-all arms, enable analyzer
  strictness, and run `dart analyze` plus transition-matrix tests.

Those language-native gates are not added by this preservation PR. Until each
repository has them, a green `fp-conformance` job is evidence only that the
recorded lexical budget did not regress.
