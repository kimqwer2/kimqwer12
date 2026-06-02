# JanggiModern search instrumentation plan

This note deliberately proposes **measurement-only** patches. It does not propose search-strength changes. The goal is to make `janggimodern` runs answer whether the existing Stockfish-derived search assumptions match JanggiModern, and especially whether cannons/checks are mis-ordered, over-pruned, or simply unproductive.

## Constraints and activation

* Gate all instrumentation behind a compile-time flag such as `-DSEARCH_STATS` plus a UCI option such as `SearchStats` or `JanggiSearchStats` so normal builds and Elo tests are byte-for-byte unaffected when disabled.
* Enable collection only for `rootPos.variant()->variantTemplate == "janggi"` or the concrete `janggimodern` key if available at the UCI layer. If variant-name access is awkward inside search, pass a boolean from the root position at `Thread::search()` startup.
* Aggregate per thread and print only at root-search completion to avoid perturbing search timing with hot-path I/O.
* Track counters by depth bucket, node type, move index bucket, and move category. For node-saving estimates, count both actual nodes searched and estimated skipped subtrees, described below.

## Shared counter schema

Add a lightweight struct, for example `SearchStats`, owned by each `Thread` and reduced by `MainThread` after `Threads.wait_for_search_finished()`.

Recommended category fields:

* `piece`: moved piece type (`JANGGI_CANNON`, `HORSE`, `ROOK`, `JANGGI_ELEPHANT`, `PAWN`, palace pieces such as `KING`/`WAZIR`, and `other`).
* `tactical`: capture/promotion, quiet, gives check, evasion/in-check node, TT move, root move.
* `palace`: from palace, to palace, both, neither. Janggi palace can be approximated by the king/advisor mobility region or the known 3x3 palace squares used by the variant.
* `ordering_index`: exact index for 1..16, then buckets `17-32`, `33-64`, `65+`.
* `depth`: exact for 0..16, then buckets `17-24`, `25+`.
* `node_type`: root/PV/non-PV/cut-node flag.

Use a helper like `stats_category(pos, move, givesCheck, captureOrPromotion, moveCount, ttMove)` immediately after legality is known. This keeps hot-path sites short and ensures all tables agree on category definitions.


## Current code map

These line numbers describe the current tree when this note was written and should be treated as anchors for the first instrumentation patch:

* `Thread::search()` iterative-deepening aspiration loop starts around `src/search.cpp:389`; aspiration window initialization is around `src/search.cpp:423`, the root search call is around `src/search.cpp:445`, and fail-low/fail-high re-search handling starts around `src/search.cpp:471`.
* Main `search()` child futility pruning returns at `src/search.cpp:928-933`.
* Null-move pruning and verification search span `src/search.cpp:935-985`, with the null search at `src/search.cpp:956-960`, cutoff gate at `src/search.cpp:962`, and verification at `src/search.cpp:973-983`.
* Step 9 ProbCut spans `src/search.cpp:987-1051`, with candidate moves from `src/search.cpp:1011-1019`, qsearch/search verification at `src/search.cpp:1027-1035`, and cutoff at `src/search.cpp:1038-1047`.
* The in-check TT ProbCut shortcut returns at `src/search.cpp:1063-1075`.
* The main move loop begins at `src/search.cpp:1104-1107`; legality filtering is at `src/search.cpp:1121-1125`; move categories are assigned at `src/search.cpp:1134-1137`.
* Main shallow pruning begins at `src/search.cpp:1142`, with move-count pruning eligibility at `src/search.cpp:1147-1151`, capture-history pruning at `src/search.cpp:1160-1164`, capture/check SEE pruning at `src/search.cpp:1166-1168`, continuation-history pruning at `src/search.cpp:1172-1176`, parent futility pruning at `src/search.cpp:1178-1187`, and quiet SEE pruning at `src/search.cpp:1189-1191`.
* Singular extension and multi-cut logic spans `src/search.cpp:1195-1252`; the broader checking extension is at `src/search.cpp:1253-1256`.
* LMR spans `src/search.cpp:1279-1356`, with reduction computation at `src/search.cpp:1291-1339`, the reduced search at `src/search.cpp:1344-1350`, and full-depth re-search at `src/search.cpp:1358-1370`.
* PV/root best-move accounting and fail-high detection span `src/search.cpp:1397-1443`, with root PV update at `src/search.cpp:1397-1418`, non-root PV update at `src/search.cpp:1434-1435`, and beta fail-high break at `src/search.cpp:1437-1442`.
* Qsearch move generation and pruning starts around `src/search.cpp:1630`, with qsearch move-count/futility pruning at `src/search.cpp:1650-1676`, qsearch negative SEE pruning at `src/search.cpp:1678-1681`, qsearch legality at `src/search.cpp:1686-1691`, qsearch continuation-history pruning at `src/search.cpp:1699-1704`, and the recursive qsearch child call at `src/search.cpp:1706-1709`.
* JanggiModern is constructed in `src/variant.cpp:1808-1816`; its base Janggi setup adds `JANGGI_CANNON` and Janggi palace-related advisor/king setup in `src/variant.cpp:1773-1796`.
* Piece types needed for category labels include `ROOK`, `JANGGI_CANNON`, `HORSE`, and `JANGGI_ELEPHANT` in `src/types.h:407-414`.

## Patch 1: mechanism fire-rate counters

Question answered: which pruning/reduction mechanisms fire most often?

Insertion points in `src/search.cpp`:

1. **Child futility pruning**: increment attempted/effective counters immediately before returning at the child-node futility return in `search()`, currently `return eval` in Step 7.
2. **Null move**: count attempted before `pos.do_null_move(st)`, searched after the null search returns, cutoff when `nullValue >= beta`, verification attempt at high depth, and verification cutoff when `v >= beta`.
3. **ProbCut**: count the Step 9 gate, candidate captures entering the ProbCut loop, qsearch pass/fail, reduced-search pass/fail, and final cutoff before `return value`.
4. **In-check TT ProbCut idea**: count the Step 11 cutoff before `return probCutBeta`.
5. **Main-move shallow pruning**: in Step 13, count move-count pruning eligibility, capture-history pruning, capture/check SEE pruning, continuation-history pruning, parent futility pruning, and quiet SEE pruning at their individual `continue` sites.
6. **Singular extension/multi-cut**: count singular candidates before the excluded-move search, single extension, double extension, multi-cut return, and `ttValue >= beta` verification cutoff.
7. **Broader check extension**: count checking-extension candidates and actual extension assignments.
8. **LMR**: count LMR candidate, applied, reduction amount, fail-high after reduced search (`value > alpha && d < newDepth`), and full-depth re-search outcome.
9. **Qsearch pruning**: repeat a smaller set for qsearch stand-pat cutoff, qsearch move-count pruning, qsearch futility pruning, qsearch SEE-futility pruning, negative-SEE pruning, and qsearch continuation pruning.
10. **Aspiration re-searches**: in `Thread::search()`, count fail-low, fail-high, number of re-search loops, final delta, and adjusted depth.

Example output:

```text
info string searchstats mechanism variant janggimodern depth 12 nodes 12345678
info string searchstats fire lmr candidates 889112 applied 603441 reduced_fh 38121 full_research_fh 22109 avg_r 2.37
info string searchstats fire prune cont_main 71544 futility_child 18839 futility_parent 29112 see_main_capture 6401 see_main_quiet 18722 qsee 94451
info string searchstats fire null attempts 24391 cutoffs 9850 verifications 221 verified_cutoffs 118
info string searchstats fire probcut attempts 3218 candidates 4087 qpass 611 cutoffs 248
info string searchstats fire singular candidates 1104 single_ext 288 double_ext 31 multicuts 71 beta_ver_cutoffs 36 check_ext 447
info string searchstats aspiration searches 12 fail_high 3 fail_low 1 max_retries 2 avg_delta_cp 31
```

## Patch 2: node-saving estimates

Question answered: which mechanisms actually save the most nodes?

Counting firings alone can be misleading. Add paired A/B node deltas for pruning and reduced searches:

* For pruning `continue`/`return` sites, estimate saved nodes from a depth-indexed baseline table of average subtree size. Populate this table online from moves actually searched: before each child search, record parent depth/newDepth and after the child returns add `nodes_after - nodes_before` to `searched_subtree_nodes[depth_bucket][category]` and increment samples. At a prune site, add the current baseline average for the relevant depth/category to `estimated_saved_nodes[mechanism][category]`.
* For LMR, directly measure nodes saved per reduced search: record nodes before the reduced search, nodes after the reduced search, and if a full-depth re-search happens, nodes for the full search. Estimate avoided full-depth cost using the same baseline for `newDepth`, then store both `reduced_nodes` and `estimated_full_nodes - reduced_nodes`.
* For null move and ProbCut returns, estimate saved nodes at the parent depth as above. Also record the actual cost paid by the null/ProbCut search so net savings can be reported.
* Report `net_est_saved = estimated_saved - instrumentation_known_cost`, not just gross saves.

Insertion points:

* Main search child calls: immediately around the reduced LMR search, full-depth NonPV search, and PV re-search sites.
* Qsearch child calls: around the recursive qsearch call.
* Prune/return sites listed in Patch 1.

Example output:

```text
info string searchstats savings mechanism gross_nodes cost_nodes net_nodes pct_total
info string searchstats savings lmr 9823341 2511120 7312221 37.4
info string searchstats savings null 5140022 449101 4690921 24.0
info string searchstats savings cont_prune 2209911 0 2209911 11.3
info string searchstats savings see_prune 1743210 0 1743210 8.9
info string searchstats savings probcut 602144 118900 483244 2.5
```

## Patch 3: fail-high and move-ordering diagnostics

Questions answered: which move categories create fail-highs, how good is ordering, and whether cannons/checks are productive.

Insertion points in `src/search.cpp`:

* After `moveCount` is assigned and legality is known in the main move loop, increment `ordered_seen[category][moveCountBucket]`.
* At the fail-high break (`assert(value >= beta); break;`), increment fail-high counters by category, depth, move index, and whether `move == ttMove`.
* At alpha raises that do not fail high, count `alpha_improvement` by category and track `value - oldAlpha` in centipawns.
* At root PV update, record `root_pv_appearance` by category and root move index.
* At non-root PV update (`update_pv(ss->pv, move, ...)`), record `pv_head_appearance` by category.
* For TT move quality, count TT move present, TT move searched, TT move legal, TT move first, TT move fail-high, and TT move alpha-improvement.

Metrics to print:

* First-move fail-high rate: fail-highs at `moveCount == 1` divided by all beta cutoffs.
* Average fail-high index: weighted average of `moveCount` at fail-high.
* TT fail-high rate: TT fail-highs divided by TT moves searched.
* Per-category ordering position: average `moveCount` and percentile buckets.
* Per-category fail-high rate: fail-highs divided by searched moves of category.
* Per-category PV appearance rate: PV appearances divided by searched moves or root appearances.

Example output:

```text
info string searchstats ordering all searched 421888 fh 151221 first_fh_rate 0.742 avg_fh_index 1.83 tt_present 198002 tt_fh_rate 0.558
info string searchstats ordering cat cannon seen 44201 avg_idx 8.71 fh 3021 fh_rate 0.068 pv_heads 417 pv_rate 0.009 score_gain_cp_avg 22
info string searchstats ordering cat check seen 30718 avg_idx 5.43 fh 3922 fh_rate 0.128 pv_heads 304 pv_rate 0.010 score_gain_cp_avg 31
info string searchstats ordering cat rook seen 53211 avg_idx 6.20 fh 5011 fh_rate 0.094 pv_heads 521 pv_rate 0.010
info string searchstats ordering idx fh_count idx1 112234 idx2 20114 idx3_4 11923 idx5_8 5281 idx9_16 1348 idx17p 321
```

## Patch 4: cannon under-ranking audit

Questions answered: are cannon moves systematically under-ranked and are cannon moves over-pruned or over-reduced?

Insertion points:

* Main move loop after legality: increment cannon `seen` and order-index tables when `type_of(movedPiece) == JANGGI_CANNON`.
* Step 13 prune sites: count cannon-specific pruned-by-mechanism counters.
* Step 16 LMR: count cannon-specific LMR applied, reduction amount, reduced fail-high, and full-depth fail-high.
* PV update sites: count cannon PV-head and root-PV appearances.
* TT move handling: count cannon TT move present and TT move fail-high.

Recommended comparison baselines:

* Cannon vs rook, because both are long-range line pieces but cannons have screen constraints.
* Cannon quiets vs all quiets.
* Cannon checks vs all checks.
* Cannon captures vs all captures.

Example output:

```text
info string searchstats cannon seen 44201 searched 33740 pruned 10461 avg_idx 8.71 avg_idx_quiet 10.02 avg_idx_capture 3.14
info string searchstats cannon prune cont 3191 see 4580 futility 932 capture_hist 211 qsee 1547 lmr_applied 18800 avg_lmr_r 2.91 lmr_fh 921
info string searchstats cannon compare rook fh_rate 0.068/0.094 pv_rate 0.009/0.010 first8_seen_pct 0.61/0.74
```

Interpretation rule:

* Cannons are likely under-ranked only if they show **high fail-high/PV rates despite late average index**, or if `lmr_fh`/full-depth-rescue rates are high relative to rook and horse moves.
* Cannons are likely correctly ranked late if late index comes with low fail-high/PV rates and low rescue rates.

## Patch 5: checking-move productivity audit

Questions answered: are checks actually productive and what is their score impact?

Insertion points:

* Main move loop after `givesCheck = pos.gives_check(move)`: count checking moves by category and order position.
* Step 13 capture/check SEE pruning: count checking captures that survive/fail SEE separately from non-check captures.
* Check extension assignment site: count eligible vs extended checks.
* After each searched move returns, if `givesCheck`, accumulate:
  * `value - oldAlpha` when `value > oldAlpha`, capped outside mate/TB ranges.
  * fail-high count.
  * PV-head count.
  * reduced-search fail-high and full-depth rescue counts if LMR applied.

Example output:

```text
info string searchstats checks seen 30718 searched 28690 pruned_see 2028 extended 447 fh 3922 fh_rate 0.128 pv_rate 0.010 avg_gain_cp 31 median_gain_bucket 0_25
info string searchstats checks bypiece cannon seen 8122 fh_rate 0.102 avg_gain_cp 18 horse seen 6044 fh_rate 0.141 avg_gain_cp 35 rook seen 7390 fh_rate 0.136 avg_gain_cp 42
```

Interpretation rule:

* Checks are productive if fail-high/PV/gain metrics exceed non-check tactical moves at the same depth and move-index buckets.
* Checks are noisy if many are seen and extended but have low PV rate and low average score gain.

## Patch 6: delayed-PV / pruned-would-have-been-PV audit

Question answered: which move types are most often reduced/pruned and later become part of the PV?

A move pruned in one node cannot literally be known to become PV without a verification search. Use two safe measurement modes:

1. **Passive delayed-PV tracking**: store a compact key `(position key, move)` for moves that were reduced, pruned by SEE, pruned by continuation history, or pruned by futility. If the same `(position key, move)` is later searched in another iteration or via TT/PV and becomes a PV head, count it as `later_pv`. This is cheap and low-perturbation.
2. **Sampling verification mode**: for 1 in N pruned moves at controlled depths, perform a verification search after the prune decision only when stats mode is enabled, then discard the result and preserve engine behavior. This is expensive and should be a separate option, e.g. `SearchStatsVerifyPrunes=N`, never used in Elo tests.

Insertion points:

* At every Step 13 and qsearch prune `continue`, record passive key and category.
* At PV update sites and root PV updates, probe the passive table for `(pos.key(), move)` and increment `later_pv_by_mechanism`.
* Optional verification searches are inserted immediately before the original `continue`, guarded by sampling and time/node limits.

Example output:

```text
info string searchstats laterpv mechanism seen later_pv sampled verified_fh
info string searchstats laterpv lmr_reduced 603441 1812 0 0
info string searchstats laterpv see_prune 25133 76 250 3
info string searchstats laterpv cont_prune 71544 211 250 2
info string searchstats laterpv futility_prune 47951 94 250 1
```

## Patch 7: chess-assumption audit

Question answered: where does search logic rely on orthodox-chess tactical assumptions that may not hold in JanggiModern?

Instrument these assumptions rather than changing them:

1. **SEE as tactical truth**: SEE pruning assumes negative material exchange is a strong proxy for bad tactics. Janggi cannons require screens and may create non-material threats. Measure SEE-pruned moves by piece/check/capture category and delayed-PV/verification hit rate.
2. **Checks are forcing**: check extension and qsearch-check generation assume checks often matter tactically. Measure checking-move fail-high/PV/gain rates and extension productivity.
3. **TT move singularity**: singular extension assumes one TT move can dominate a node. Measure singular candidate pass rates, double-extension outcomes, multi-cut rates, and whether singular-extended moves actually become PV heads.
4. **Quiet history generalizes across piece geometry**: continuation-history pruning assumes history is sufficiently calibrated. Measure continuation-pruned delayed-PV/verification hit rate by cannon/horse/rook/palace categories.
5. **Late quiets are mostly bad**: LMR and move-count pruning assume later quiets rarely fail high. Measure fail-high index curves and LMR rescue rates by Janggi piece type.
6. **Captures dominate qsearch tactically**: qsearch mostly searches captures/checks and negative SEE filters. Measure qsearch stand-pat vs searched-check/capture cutoffs and whether cannon checks/captures are discarded by SEE.
7. **Null move safety**: null move assumes passing is a tactical concession. Janggi has actual pass permissions in base Janggi variants, so measure null cutoffs, verification failures, and positions where null move is legal/semantically close to a pass.

Example output:

```text
info string searchstats assumption see_pruned later_pv_rate cannon 0.007 rook 0.003 horse 0.002 all 0.004
info string searchstats assumption late_quiet_fh idx9p cannon 0.014 rook 0.009 horse 0.011 all 0.006
info string searchstats assumption checks ext_fh_rate 0.041 non_ext_check_fh_rate 0.132 pv_rate 0.010
info string searchstats assumption singular pv_after_ext 0.183 double_ext_pv 0.064 multicut_rate 0.064
info string searchstats assumption null verification_fail_rate 0.466 net_savings_pct 24.0
```

## Highest-confidence evidence hypotheses to test

These are not Elo patches; they are hypotheses that become high-confidence only if the instrumentation output matches the listed evidence pattern.

1. **Search is dominated by LMR, null move, and continuation/futility pruning rather than ProbCut or singular extension.** Evidence: high fire counts and high net estimated node savings for LMR/null/continuation/futility, with low ProbCut/singular net savings.
2. **JanggiModern move ordering is healthy if most fail-highs occur at move 1 or the TT move.** Evidence: first-move fail-high rate above roughly 65%, TT fail-high rate high after legal TT moves, and average fail-high index near 2.
3. **Cannons are under-ranked only if they are late but tactically successful.** Evidence: cannon average index materially later than rook/horse while cannon fail-high/PV/reduced-rescue rates are equal or higher after controlling for depth and capture/check status.
4. **Checking moves are not automatically productive in JanggiModern.** Evidence: checking moves have low PV rate, low average score gain, and check-extension fail-high/PV rates no better than non-extended checking moves.
5. **SEE relaxation is likely harmful if SEE-pruned cannon/horse moves almost never reappear as PV or verify as fail-high.** Evidence: low delayed-PV and sampled verification hit rates for SEE-pruned cannon/horse moves, matching the prior negative Elo result for SEE relaxation.

## Suggested minimal implementation order

1. Fire-rate counters for main search and qsearch, plus aspiration re-search counters.
2. Move-category classification and fail-high/order/PV counters.
3. Node-saving estimates using online subtree averages.
4. Cannon and check focused reports.
5. Passive delayed-PV tracking.
6. Optional sampled verification mode only after passive results identify a suspicious mechanism.
