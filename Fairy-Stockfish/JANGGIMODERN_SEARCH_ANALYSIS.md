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
