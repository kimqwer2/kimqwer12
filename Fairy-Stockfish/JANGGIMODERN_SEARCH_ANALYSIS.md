# JanggiModern specialized search analysis

## Source differences reviewed

The checked-in Alice-Stockfish and Horde-Stockfish trees are based on a newer Stockfish search than this Fairy-Stockfish tree. The largest concrete differences are:

* Both Alice and Horde have static-evaluation correction history (`correction_value()`, pawn/minor/non-pawn/continuation correction tables, and correction-history updates). Fairy-Stockfish does not have that framework in `search.h`/`search.cpp`.
* Both use newer capture and continuation history scoring in move picking, including six continuation-history slots for quiet ordering and capture-history integration in ProbCut move generation.
* Both use newer futility, null-move, ProbCut, singular-extension, LMR, qsearch, and TT-save formulas. These are mostly scalar changes around the same Stockfish mechanisms already present in Fairy-Stockfish.
* Alice explicitly disables classical SEE for Alice (`ALICE_SEE_AVAILABLE = false`) because two-board transfers make SEE unreliable. This is a direct example of variant-specific search gating instead of rule changes.
* Horde keeps the generic SEE path but adds Horde telemetry/gating and updated pruning scalers. The Horde-specific assumptions are tied to Horde's asymmetric material/terminal semantics and are not directly portable to JanggiModern.

## Applicability classification

### A. Directly applicable to JanggiModern

* A variant-local search policy layer is appropriate: the references both make variant-specific search decisions rather than changing rules.
* Alice's lesson that unreliable SEE should not drive pruning is applicable to JanggiModern cannon tactics. Janggi cannons have screen-dependent attacks and cannot capture cannons; Fairy-Stockfish already has special SEE code for this, but SEE remains a coarse predictor for pruning cannon/check tactics.
* A more conservative ProbCut margin is applicable because ProbCut verifies capture-only candidates at reduced depth, while JanggiModern cannon screens and palace geometry can hide quiet refutations.
* Check extensions should be more selective for JanggiModern. The instrumentation note warns that checks may not be automatically productive; preserving cannon/capture checks while avoiding all quiet check extensions is a conservative adaptation.

### B. Applicable only after Janggi-specific adaptation

* Correction history could be useful, but importing the newer framework would be invasive and would need JanggiModern validation over the NNUE/static-eval interface. It was not ported in this pass.
* Newer LMR/futility scalar formulas might help, but they are intertwined with correction history and newer history tables. Blind replacement could change every variant or destabilize JanggiModern.
* Capture-ordering formulas from Alice/Horde are plausible but depend on their newer history layout and were not transplanted into the older Fairy-Stockfish architecture.

### C. Unsafe / not applicable

* Alice two-board logic and its wholesale SEE disable are not semantically correct for JanggiModern.
* Horde rule/terminal assumptions are not portable to JanggiModern.
* NNUE feature, accumulator, and EvalFile workflow changes were rejected by constraint; no NNUE architecture or semantics were changed.
* Move generation, legality, FEN, variant registration, terminal handling, UCI, and WinBoard rules were not changed.

## Implemented changes

Changed `src/search.cpp` only:

* Added `is_janggimodern()` to identify the modern Janggi rule set from existing variant properties.
* Added `janggimodern_see_sensitive()` to prevent SEE-based forward pruning of JanggiModern checking moves, cannon moves, and captures involving cannons.
* Added `janggimodern_probcut_margin()` to require a larger ProbCut margin for JanggiModern.
* Gated shallow SEE pruning and quiet negative-SEE pruning through the JanggiModern SEE-sensitive helper.
* Made JanggiModern check extensions selective: cannon checks and capture checks can still extend, but ordinary quiet checks no longer automatically extend.

## Compatibility validation results

Commands run from `Fairy-Stockfish/src` unless noted:

* `make -j2 ARCH=x86-64 build` passed for the normal build.
* `make clean >/dev/null && make -j2 ARCH=x86-64 largeboards=yes all=yes build` passed for the all-variants/largeboards build required to expose JanggiModern.
* `printf 'uci\nsetoption name UCI_Variant value janggimodern\nisready\nposition startpos\ngo perft 1\nquit\n' | ./stockfish` initialized JanggiModern and returned 32 legal root moves from the current start position.
* `printf 'uci\nsetoption name UCI_Variant value chess\nisready\nposition startpos\ngo depth 3\nquit\n' | ./stockfish` confirmed a normal Fairy-Stockfish variant still initializes and searches.
* `printf 'xboard\nprotover 2\nvariant janggimodern\nnew\nquit\n' | ./stockfish` returned WinBoard feature negotiation and JanggiModern setup output.
* `printf 'uci\nsetoption name UCI_Variant value janggimodern\nsetoption name EvalFile value janggimodern-18.nnue\nisready\nquit\n' | ./stockfish` accepted the EvalFile option and returned `readyok`. This build has `NNUE_EMBEDDING_OFF`/`nnue: no`, so network loading was not exercised.
* `./stockfish bench` passed after changes: 6,257,668 nodes, 13,587 ms, 460,562 NPS in the all-variants/largeboards build.
* `../tests/protocol.sh` could not run because `expect` is not installed in the environment.

## Bench / NPS

* A normal non-largeboards build before the all-variants rebuild produced 6,180,480 nodes and 628,225 NPS. This is not an apples-to-apples JanggiModern build because JanggiModern is not exposed without largeboards/all variants.
* The validated all-variants/largeboards build after changes produced 6,257,668 nodes and 460,562 NPS.
* No reliable before/after Elo or NPS claim is made from these mixed build modes.

## Self-play

No local self-play or fishtest harness was found or run in this pass, so no strength claim is made.

## Remaining uncertainty

The changes are tactical-risk reductions rather than proven Elo gains. The most important next validation is a controlled self-play match against an unchanged all-variants/largeboards JanggiModern baseline using the same NNUE, hash, threads, time control, openings, color swaps, and adjudication.

## Second-pass rewrite additions

After the review feedback, the implementation was expanded beyond the initial safety patch:

* Added a JanggiModern correction-history implementation in the existing Fairy architecture. It keeps pawn-key, full-position/non-pawn-key, and continuation correction tables in each search thread and applies the learned correction to static evaluation only for JanggiModern.
* Stored both corrected and uncorrected static evals in the search stack so TT eval storage and correction-history updates can preserve the raw evaluator/NNUE output while pruning and improving logic consume the corrected value.
* Updated correction history after quiet best moves when search results disagree with the raw static eval or cross the beta boundary. Captures are intentionally excluded because Janggi cannon exchanges and tactical captures are already handled by capture search/history rather than static correction.
* Kept all correction-history state in normal in-memory thread structures; no debug logging or file I/O was added.

### Additional files/functions changed

* `src/movepick.h`: added `JanggiCorrectionHistory` based on the existing `Stats` gravity/clamping framework.
* `src/thread.h` / `src/thread.cpp`: added and cleared per-thread JanggiModern correction tables.
* `src/search.h`: added `Stack::uncorrectedStaticEval`.
* `src/search.cpp`: added correction calculation/application/update helpers; raw-eval TT storage; corrected static-eval use for JanggiModern pruning, improving, and LMR inputs.

### Additional validation

* `make -j2 ARCH=x86-64 largeboards=yes all=yes build` passed after correction-history integration.
* `./stockfish bench` passed after correction-history integration: 6,424,691 nodes, 14,229 ms, 451,520 NPS in the all-variants/largeboards build.
* `make -j2 ARCH=x86-64 largeboards=yes all=yes nnue=yes build` passed far enough to build and run with `nnue: yes`; the default chess NNUE download failed checksum/network validation, but explicit JanggiModern EvalFile loading was validated.
* `setoption name EvalFile value /workspace/kimqwer12/janggimodern-18.nnue` followed by `go depth 1` printed `NNUE evaluation using /workspace/kimqwer12/janggimodern-18.nnue enabled` and returned a best move.
* `setoption name EvalFile value /workspace/kimqwer12/janggimodern-19.nnue` followed by `go depth 1` printed `NNUE evaluation using /workspace/kimqwer12/janggimodern-19.nnue enabled` and returned a best move.

### Updated remaining weaknesses

This is now a broader JanggiModern search/evaluation integration change, but still not a proven +Elo result. No self-play harness was found in the repository, so strength remains unclaimed pending controlled matches. Further work should tune correction-history scaling, evaluate independent toggles for LMR/ProbCut/qsearch, and run SPRT or at least fixed-game self-play against the previous commit with identical NNUE/hash/threads/time controls.

## Final-pass architecture review and changes

The final self-review found that the previous version still left MovePicker, LMR, pruning confidence, and qsearch static-eval handling too close to old Fairy behavior. The final pass therefore added:

* A JanggiModern tactical move-ordering model in `src/movepick.cpp`. Captures, quiets, and evasions now receive explicit ordering bonuses for cannon checks, rook checks, cannon captures, captures of cannons, horse/elephant tactics, and low-value palace shuffles. This is not a rules change; it changes only the order in which existing legal moves are searched.
* A JanggiModern tactical-weight model in `src/search.cpp` shared by pruning and LMR decisions. It classifies cannon, rook, horse, elephant, check, and cannon-capture moves so pruning can be informed by Janggi tactical context instead of only generic chess SEE/history.
* History-aware pruning exemptions for JanggiModern tactical moves. Continuation-history pruning and parent futility pruning now avoid pruning moves with enough tactical weight unless history is strongly negative.
* JanggiModern LMR adjustment. Tactical cannon/check/rook/horse/elephant moves receive reduced reductions; bad-history, non-tactical, non-checking quiet moves can be reduced more aggressively. This turns LMR into a selective Janggi policy rather than a single global scalar.
* QSearch static-eval correction. JanggiModern qsearch now applies the same correction-history layer as main search while preserving uncorrected eval for TT storage.

### Final architecture answers

1. Major Fairy subsystems replaced/redesigned: JanggiModern static-eval handling, correction history, tactical move ordering, tactical pruning exemptions, LMR adjustment, and qsearch static-eval integration.
2. Alice ideas implemented: variant-specific SEE distrust, variant-local search policy, and correction-history-style static-eval feedback.
3. Horde ideas implemented: newer search/eval feedback concept, stronger capture/continuation-history dependence, and history-informed pruning/reduction behavior.
4. JanggiModern-specific redesign: cannon/check/rook/horse/elephant tactical weighting, cannon-prioritized ordering, tactical pruning exemptions, and selective LMR.
5. Old Fairy assumptions remaining: alpha-beta framework, TT format, generic legal move generation, base MovePicker stages, and existing NNUE feature pipeline.
6. Why remaining assumptions are safe: they are protocol/search-framework mechanisms or already-correct rules/NNUE systems; Janggi-specific risk points are now intercepted above the rules layer.
7. Code changed: final amended commit changes `JANGGIMODERN_SEARCH_ANALYSIS.md`, `src/movepick.cpp`, `src/movepick.h`, `src/search.cpp`, `src/search.h`, `src/thread.cpp`, and `src/thread.h`.
8. NNUE loaded: both `/workspace/kimqwer12/janggimodern-18.nnue` and `/workspace/kimqwer12/janggimodern-19.nnue` printed `NNUE evaluation using ... enabled` and returned best moves.
9. UCI worked: JanggiModern initialized, perft 1 returned 32 root moves, and depth search returned a best move.
10. WinBoard worked: `xboard/protover 2/variant janggimodern/new` returned feature negotiation and setup output.
11. Legal move generation remained unchanged by source scope: no movegen, legality, make/undo, FEN, or variant-registration files were changed; start-position perft 1 remained 32 moves.
12. NPS: final all-variants/largeboards bench reported 6,264,613 nodes, 15,839 ms, 395,518 NPS. The NPS cost is expected from more tactical ordering and correction integration; no strength claim is made without games.
13. Self-play: no self-play/fishtest/cutechess harness was found in the repository or environment, so no Elo result is reported.
14. If strength does not improve: the next controlled investigation should tune tactical weights and LMR/pruning thresholds independently, using the JanggiModern NNUE files and fixed opening/FEN suites.
