# Engine Integration Audit (LiGround + Fairy-Stockfish)

Date: 2026-05-24

## Scope
Strict code-path audit of Fairy-Stockfish process creation, UCI option propagation (EvalFile / Use NNUE / Threads), real-time commentary, current-game reflection replay, and async/race risks.

## Key Findings (Executive)

1. **Main analysis engine + eval/review worker share a mirrored option pipeline** via `Engine.send()` and `_shouldMirrorCommandToEval()`. This covers `setoption` commands including NNUE and Threads for those two workers.
2. **PvE and EvE engines are spawned as independent `Engine` instances but never receive persisted UI engine options** (only variant + 960), so their NNUE/Threads settings can silently differ from UI settings.
3. **Real-time strategic commentary and current game reflection both run on eval worker** (`engine.reviewAnalysis`), so they inherit mirrored options *if* those options were sent before review requests.
4. **At least one async sequencing risk exists:** analysis requests can be launched without an explicit barrier guaranteeing all prior mirrored `setoption` commands have fully completed on eval worker.
5. **Deep-analysis and review mutate shared eval-worker engine options (e.g., `MultiPV`) and rely on restoration discipline**; cancellation paths can leave temporary states if interrupted mid-flow.

## Detailed Architecture Review

### 1) Process/Engine Creation Points

#### A. Main global analysis engine + eval/review engine worker pair
- Created in `Engine` constructor: `mainWorker` and `evalWorker` are both `new EngineWorker()`.  
- Both processes are spawned in `Engine.run(binary, cwd)` by posting `type: 'run'` to each worker.
- Worker-side `run()` actually spawns the Fairy-Stockfish child process via `spawn(binary, [], { cwd })` and constructs `EngineDriver`.

Consequence: the app has **two long-lived Fairy-Stockfish processes** for normal analysis workflow (main + eval).

#### B. PvE engine
- `PvEtrue` constructs a *new* `Engine()` instance (`const pveEngine = new Engine()`), runs it, and only sets `UCI_Variant` + `UCI_Chess960`.

Consequence: this engine does not automatically receive global UI options snapshot (Threads / EvalFile / Use NNUE) from the main store pipeline.

#### C. EvE engines (white/black)
- `EvEtrue` constructs two separate `Engine()` instances and runs both.
- Only `UCI_Variant` + `UCI_Chess960` are applied.

Consequence: both engines are also detached from persisted UI option propagation.

### 2) UCI Option Propagation Flow

#### Main mechanism (good path)
- All `engine.send(command)` calls pass through `Engine.send()`.
- `setoption` commands are tracked in `optionState` (`_trackOptionFromCommand`).
- Commands are mirrored to eval worker via `_shouldMirrorCommandToEval()` for `setoption`, `stop`, `ucinewgame`, variant/evalfile markers.
- On `run()`, after both workers are active, `_applyOptionSnapshotToWorkers()` replays tracked `setoption`s to both workers.

This is the intended centralized propagation for the **global** engine instance.

#### UI settings source
- `setEngineOptions` in store dispatches `engine.send('setoption ...')` for each entry and persists to `state.engineSettings` / localStorage.
- `initEngineOptions` loads stored settings and sends them via `setEngineOptions` after `runBinary`.

#### Worker enforcement detail
- Worker `exec()` parses `setoption`; for `EvalFile`, it performs local path resolution + existence check before sending to engine.
- If missing, it emits NNUE warning event and **returns early** (does not apply invalid file).

### 3) Real-time Commentary Audit

- Real-time review requests route through `requestReview()` and `engine.reviewAnalysis(...)` on the eval worker.
- `reviewAnalyze()` in worker executes variant + `MultiPV` + `UCI_ShowWDL`, then sequential searches.
- No temporary child process is created per request; it reuses eval-worker engine process.

Assessment:
- **NNUE/Threads likely applied** if previously mirrored via `setEngineOptions` and not overwritten.
- **Risk:** no explicit option-sync barrier before each review dispatch; pending async `setoption` completion timing could race with immediate review dispatch.

### 4) Current Game Reflection Audit

- Full replay is `replayPlayedLineReview()` -> loops move-by-move -> `reviewPlayedLine()` -> `requestReview()` for each prefix line.
- Each step calls eval-worker `reviewAnalyze()`; engine is reused, not respawned each move.
- Within review loop, worker mutates `MultiPV` per phase (root/user/per-move) and restores to `multiPv` at end.

Assessment:
- **Engine recreation between moves:** not observed in this path.
- **Option persistence:** mostly preserved, but relies on non-interrupted completion for restoring temporary `MultiPV` state.

### 5) Global Fairy-Stockfish Usage Audit Summary

All identified Fairy-Stockfish process creation/usage locations:
- `src/renderer/engine/engine.worker.js`: actual `child_process.spawn`, all UCI execution.
- `src/renderer/engine/index.js`: orchestrates dual workers, mirrors options, exposes `evaluate`, `reviewAnalysis`, `deepAnalysis`.
- `src/renderer/store.js`: starts main engine lifecycle and additional PvE/EvE engine instances.
- `src/renderer/components/EngineConsole.vue`: creates an ad-hoc `new Engine()` for console testing/inspection.

Propagation guarantees:
- **Guaranteed for global main+eval pair:** generally yes via mirrored `setoption` + snapshot replay.
- **Not guaranteed for PvE/EvE/EngineConsole extra instances:** no shared centralized application of stored `engineSettings` observed.

### 6) Async / Race / State Risks

1. **Option-application race before analysis start**
   - `setEngineOptions` sends commands immediately, but review/deep requests can be triggered without explicit await of eval-worker ready after all mirrored options.
2. **Shared eval-worker mutable state**
   - `reviewAnalyze` and `deepAnalyze` both alter engine options (`MultiPV`, `UCI_ShowWDL`, optionally clear hash), and cancellation/interleaving can leave transient states.
3. **`stop` side effects**
   - `Engine.send` pushes `stop` to eval worker before setoption updates; if competing long-running operations exist, this can affect active analysis lifecycle unexpectedly.
4. **Detached engine instances**
   - PvE/EvE/console instances are independent and can run defaults when users expect configured NNUE/Threads.

## Subsystem Verdict Matrix

- **Global analysis main worker:** NNUE/Threads propagation **probably applied** (mirrored commands + snapshot logic), with sequencing caveat.
- **Global eval/review worker:** NNUE/Threads propagation **probably applied**; strongest risk is timing/interleaving.
- **Real-time strategic commentary:** **probably applied** (same eval worker path), not definitive due to async timing.
- **Current game reflection replay:** **probably applied** (same eval worker reused per step), with temporary-option restore risks.
- **PvE engines:** **uncertain to broken for user expectation** (config not centrally injected; likely defaults except variant/960).
- **EvE engines (white/black):** **uncertain to broken for user expectation** (same gap).
- **EngineConsole ad-hoc engine:** **uncertain** unless user manually re-enters options.

## Suspicious/High-Risk Patterns to Refactor

1. Multiple engine bootstraps (`runBinary`, `PvEtrue`, `EvEtrue`, console engine) with duplicated partial init.
2. Option state tracked per `Engine` instance but no global “engine profile applicator” invoked for every new instance.
3. Analysis entrypoints lack a strict “options-applied barrier token” before launching searches.

## Recommended Fixes

1. **Centralize engine configuration application**
   - Add `applyConfiguredOptions(engineInstance, settings)` helper.
   - Call it from `runBinary`, `PvEtrue`, `EvEtrue`, and EngineConsole startup.
2. **Introduce explicit readiness barrier**
   - Add an async `engine.flushOptionSync()` promise that resolves when both workers have acknowledged all queued `setoption` updates (`readyok` barrier).
   - Await this before `reviewAnalysis` / `deepAnalysis` / commentary dispatch.
3. **Isolate review/deep option mutations**
   - Save and restore transient option values with `try/finally` in worker analysis routines.
4. **Protect against interleaving**
   - Add per-worker operation mutex/queue so only one long analysis operation mutates shared options at once.
5. **Observability**
   - Emit structured events containing effective options snapshot at analysis start (variant, Threads, Use NNUE, EvalFile).

## Suggested Refactoring Target

Create an `EngineConfigService` (or module) that:
- owns canonical UI-configured UCI option snapshot,
- applies snapshot to any new `Engine` instance,
- provides `await ensureApplied(instance)` method,
- optionally validates critical options (`EvalFile` exists, Threads bounds, variant compatibility).

This removes duplicated initialization logic and closes hidden-default-instance drift.
