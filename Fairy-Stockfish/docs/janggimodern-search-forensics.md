# JanggiModern search architecture forensics

This note records the source-level comparison that invalidated the reverted
`SearchProfile` approach. It is intentionally kept in-tree so future engine work
starts from the architectural evidence rather than another small margin patch.

## Structural comparison

Line-level similarity between Fairy-Stockfish and the dedicated reference engines
is very low in the core engine files: `search.cpp` is about 10% similar to Alice
and Horde, `search.h` is about 11-12% similar, and `movepick.cpp` is about 10%
similar. The reference engines are therefore not small variant patches on Fairy;
they are effectively modern Stockfish search frameworks adapted to dedicated
variants.

## Major architectural differences

| Area | Classification | Fairy-Stockfish | Alice/Horde | Strength relevance |
| --- | --- | --- | --- | --- |
| Search ownership | A/F | Mostly free functions using `Thread` state. | `Search::Worker`, `SharedState`, and `SearchManager` split per-worker search from shared correction/TT/time state. | High: enables coherent state flow and modern per-worker histories. |
| Stack | F/H | `pv`, continuation history pointer, killers, stat score, TT flags, double-extension count. | Adds continuation correction history, `followPV`, cutoff count, and stored LMR reduction. Removes classic killers from the stack. | High: reduction/research decisions are stateful, not just depth/move-count formulas. |
| Static evaluation | H/F | Raw NNUE/classical eval is stored and used directly, with occasional TT replacement. | Raw eval is corrected by pawn/minor/non-pawn/continuation correction history before pruning, LMR, and qsearch stand pat. TT stores raw eval separately. | Very high: same NNUE becomes stronger because search learns systematic eval bias. |
| History architecture | F/G/H | Main history, gate history, low-ply history, capture history, continuation history, counter moves, killers. | Main/low-ply/capture/continuation plus continuation correction; no classic killer stack; history enters LMR with larger weighted formulas. | Very high: move ordering and reduction are coupled. |
| Move picker | G | Stage machine with TT, good captures, refutations/killer/countermove, quiets, bad captures. | Modern staged picker with scored ranges and history-weighted capture/quiet ordering; no killer/countermove architecture. | High: reduces move-ordering pollution from chess-era killers. |
| LMR | A/F/G/H | Static reductions table adjusted by PV, TT hit average, cut node, tt capture, and stat score. | Log reductions with root-delta term, correction-value term, ttPv term, cutoff-count term, first-picked move handling, history-weighted stat score, and post-LMR depth adjustment. | Very high: Alice/Horde gains plausibly depend on this interacting system. |
| Correction history | A/F/H | Absent. | Pawn/minor/non-pawn/continuation correction histories update on reliable searched bounds/exacts and feed pruning/reductions/qsearch. | Very high: core same-NNUE gain mechanism. |
| ProbCut/TT | A/F | Older ProbCut path and TT save API. | Modern TT writer/data abstraction; ProbCut writes lower bounds and interacts with corrected eval and capture history. | Medium/high. |
| Qsearch | A/F/H | Capture/check qsearch with raw/corrected-by-TT stand pat and SEE filtering. | Modern qsearch uses corrected eval and modern move picker/history inputs. | High: JanggiModern needs tactically stable stand pat because cannon screens make quiet/capture transitions sharp. |
| Time/search manager | A/C/F | Main thread time handling interleaved with search functions. | Dedicated `SearchManager`; root move effort/average/mean-squared scores improve instability handling. | Medium. |
| Rules/position | D/E | Generic many-variant rules and NNUE aliases. | Dedicated variant rules and smaller position types. | Necessary for references, but not transferable directly to JanggiModern. |

## Likely source of Alice/Horde Elo gains

The gains are not explained by NNUE bytes alone. The plausible source is the
modern search system as an interacting whole: corrected static evaluation,
history-driven reductions, modern move picking, qsearch using corrected eval,
updated TT/research behavior, and root search instability handling. Cherry-picking
one margin or disabling one pruning rule misses those interactions.

## JanggiModern transfer plan

The transferable idea is not Alice/Horde rules. The transferable architecture is:

1. Keep Fairy's JanggiModern position/rules/FEN/NNUE/protocol code unchanged.
2. Add a real modern search subsystem for JanggiModern with its own worker state,
   stack fields, correction histories, move picker policy, LMR/research model,
   qsearch semantics, and TT/static-eval discipline.
3. Select that subsystem at search entry for `UCI_Variant=janggimodern`; do not
   thread `if (janggimodern)` through Fairy's existing search loop.
4. Validate strength with baseline-vs-new self-play using the same NNUE, hash,
   threads, time control, openings, and colors.

## Failed experiment retained for audit

A direct in-place correction-history experiment was tested against the baseline
with a minimal UCI depth-4 four-game harness using `janggimodern-18.nnue`. It
scored 0 wins, 2 losses, and 2 draws for the new engine, so it was discarded.
That result reinforces the main conclusion: partial modernization inside the old
Fairy search is insufficient and can regress strength.
