# Codex task: JanggiModern specialized Fairy-Stockfish search

## Objective

Use the checked-in `Alice-Stockfish-main` and `Horde-Stockfish-main` implementations as research references and specialize `Fairy-Stockfish` for `janggimodern`.

The goal is strength improvement from search/evaluation integration while keeping the existing JanggiModern rules and NNUE compatibility intact.

## Important hard constraints

1. Do NOT redesign, replace, simplify, or reinterpret the existing Janggi/JanggiModern rules.
2. The current `janggimodern` move generation, legality, terminal handling, FEN handling, WinBoard/UCI behavior, and variant registration are considered correct and must remain compatible.
3. Do NOT change the NNUE architecture or feature semantics. Existing `janggimodern-18.nnue` and `janggimodern-19.nnue` must remain loadable with the same `EvalFile` workflow.
4. Do NOT require a new GUI or a new protocol. The resulting binary must remain usable exactly like the current Fairy-Stockfish binary from WinBoard and other UIs.
5. Do not copy Alice-specific two-board logic, Horde-specific rules, or variant-specific assumptions that do not make semantic sense for JanggiModern.
6. Preserve all existing variants unless a change is explicitly gated to `janggimodern`.
7. Do not make a strength claim from source inspection. Build and regression-test first, then report what was actually validated.

## Research references

The repository contains:

- `Alice-Stockfish-main/`
- `Horde-Stockfish-main/`
- `Fairy-Stockfish/`

Alice-Stockfish reports large gains against Fairy-Stockfish with the SAME legacy NNUE:

- 2s+0.02: +350.87 Elo, 700 games, 618-0-82
- 10s+0.1: +249.64 Elo, 500 games, 404-0-96
- 30s+0.3: +211.54 Elo, 300 games, 231-1-68

Horde-Stockfish reports:

- 2s+0.02: +418.46 Elo, 600 games
- 10s+0.1: +396.68 Elo, 400 games
- 30s+0.3: +350.27 Elo, 200 games

The important observation is that large gains can come from variant-specialized search/evaluation integration, not only from retraining an NNUE.

## Existing JanggiModern instrumentation

Read `Fairy-Stockfish/docs/search_instrumentation_janggimodern.md` before changing search. It identifies the important search mechanisms:

- child/parent futility pruning
- null move and verification
- ProbCut
- in-check ProbCut
- move-count/capture-history/SEE/continuation-history pruning
- singular extension and multi-cut
- check extension
- LMR and full-depth rescue searches
- qsearch pruning
- aspiration re-searches
- move-ordering and fail-high behavior
- cannon/check productivity

Use that document as a measurement map, not as a mandate to keep instrumentation enabled in normal builds.

## Required workflow

### Phase 1: source analysis

Compare the relevant search/evaluation code in Alice-Stockfish and Horde-Stockfish against Fairy-Stockfish. Identify concrete differences that can plausibly explain their strength gains.

Focus on:

- move ordering
- history/counter/continuation history use
- capture ordering
- SEE assumptions
- null move pruning
- futility pruning
- ProbCut
- singular extensions
- check extensions
- LMR
- qsearch pruning
- aspiration behavior
- transposition-table usage
- static evaluation correction / correction history
- NNUE accumulator/evaluation integration
- variant-specific terminal/tactical handling

Separate every finding into:

A. directly applicable to JanggiModern
B. applicable only after Janggi-specific adaptation
C. unsafe/not applicable

Do not port code merely because it exists in Alice/Horde.

### Phase 2: implement

Implement all changes that Codex judges technically justified for JanggiModern. Prefer a clean JanggiModern-specific policy/helper layer over scattering unrelated `if (variant == ...)` checks through generic chess code.

If an existing Stockfish mechanism is harmful for JanggiModern, adapt or gate it rather than changing the rules.

Pay special attention to cannons. JanggiModern has cannon-specific tactical geometry, so chess SEE/order/pruning assumptions may be wrong even when move legality itself is correct.

Also evaluate horses, elephants, rooks, pawns, palace pieces, checks, captures, and quiet moves separately where the search mechanism depends on tactical reliability.

### Phase 3: compatibility validation

Before claiming success, verify:

- project builds successfully
- normal Fairy-Stockfish variants still build and run
- `janggimodern` initializes correctly
- current starting FEN and representative FENs load correctly
- legal move generation remains unchanged
- make/undo restores the exact position state
- check/checkmate/stalemate/terminal behavior remains unchanged
- UCI works
- WinBoard-style usage remains compatible
- `EvalFile` still accepts the existing JanggiModern NNUE files
- NNUE incremental/full evaluation parity is preserved where existing tests cover it
- bench runs
- perft/regression tests relevant to JanggiModern pass

Do not replace the existing NNUE files.

### Phase 4: performance sanity

Measure NPS/bench before and after. A large Elo-oriented change that destroys a substantial amount of NPS needs explicit justification.

Do not leave debug telemetry, hot-path file I/O, verbose logging, or experimental instrumentation enabled in the normal release path.

### Phase 5: strength validation

If a local self-play/fishtest harness is available, run a controlled comparison against the current Fairy-Stockfish JanggiModern baseline using:

- same NNUE
- same hash
- same threads
- same time control
- same opening/input positions
- colors swapped
- identical adjudication policy

First compare at least a short fixed sample. Only call a change "stronger" when the actual test supports it.

## Deliverables

1. Implement the changes in `Fairy-Stockfish`.
2. Keep the changes JanggiModern-specific unless a change is proven safe and useful for all variants.
3. Add concise comments explaining why each non-obvious JanggiModern-specific search change exists.
4. Build and run available tests.
5. At the end, write `JANGGIMODERN_SEARCH_ANALYSIS.md` containing:
   - exact Alice/Horde differences found
   - which differences were ported
   - which were rejected and why
   - files/functions changed
   - compatibility test results
   - bench/NPS before vs after
   - self-play result if available
   - any remaining uncertainty

## Critical instruction

Do the analysis and implementation in one pass. Do not stop after producing recommendations. Make the code changes, build, test, and fix compile/test failures yourself. Do not ask the user to decide which search mechanisms to port; use the evidence in the source code and JanggiModern semantics to make that engineering decision.
