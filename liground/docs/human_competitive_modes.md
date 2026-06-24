# Human Competitive Modes Architecture

## Recommendation

Pressure, Hunter, and Closer should live in Liground, not Fairy-Stockfish. They are personality and move-selection policies layered over engine output. Fairy-Stockfish should continue to provide search, evaluation, NNUE, and MultiPV generation.

## Technical comparison

| Mode | Can use existing MultiPV? | Can Liground weight candidates? | Engine-only data needed? | Engine-side advantage? | Recommendation |
| --- | --- | --- | --- | --- | --- |
| Pressure | Yes. MultiPV gives PV rank, score, best move, and PV line. | Yes. Liground can filter by CP loss and weight forcing/capture/reply-space signals. | No. The initial implementation only used root score, capture, check-like forcing approximation, and PV length, all reproducible or approximable in Liground. | No meaningful advantage; keeping it in `search.cpp` only hides UI personality state in engine settings. | Move to Liground. |
| Hunter | Yes. Trigger can use the latest root best score plus the configured training threshold. | Yes. Liground already owns opponent-training thresholds and can persist hunter state between engine moves. | No. The previous engine implementation did not calculate true previous-move regret; it triggered from current root advantage, which UCI MultiPV exposes. | No. GUI-side state is better because Hunter is tied to training/personality settings. | Move to Liground. |
| Closer | Yes. Match-state bands can be inferred from root best CP. | Yes. Liground can prefer safer conversion, pressure, imbalance, or counterplay within a CP band. | No. Simplification and forcing approximations can use PV captures, legal reply counts, and candidate scores. | No unless future work needs new search-internal strategic terms. | Move to Liground. |

## Why Liground is preferred

- Users can toggle personality modes directly in the Liground UI without opening engine settings.
- The same candidate pool can stack with Chaos, Opponent Training, Human Trap, Controlled Margin, and other practical-style systems.
- The implementation remains engine-agnostic as long as the engine supports UCI MultiPV.
- No extra Fairy-Stockfish maintenance burden or risk of changing core search behavior.

## When engine-side code would be justified

Engine changes would only be justified if a future mode requires information unavailable through UCI, such as internal search node statistics, NNUE feature decomposition, exact attack-map deltas from search, or a measurable Elo/performance gain from integrating the policy during move ordering rather than after root MultiPV generation.
