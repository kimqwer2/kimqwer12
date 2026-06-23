# Human Competitive Modes

Fairy-Stockfish now exposes three independent UCI toggles that alter root move selection after the normal search has produced principal variations. The modes are intentionally implemented as a low-overhead personality layer rather than as new search terms, so engine strength is preserved by keeping all selected moves inside a bounded MultiPV candidate pool.

## Reused architecture and signals

- The existing root `MultiPV` pipeline already searches and stores candidate principal variations in `RootMove::pv` with centipawn-like `RootMove::score` values.
- Tactical and pressure signals are available cheaply at root with existing `Position` helpers: `gives_check()` and `capture()`.
- Match-state information is approximated from the top root score, which is already computed by search.
- Existing NNUE code returns a scalar evaluation; it does not expose decomposed strategic features that can be used directly without adding new instrumentation.
- Existing attack maps and move generation are available, but the first implementation avoids extra root make/unmake or secondary searches. This keeps the feature cheap and avoids major search overhead.

## Mode behavior

### Pressure Mode

`Pressure Mode` enables probabilistic selection from a configurable top-PV pool. PV1 is always included and heavily weighted, while non-PV1 candidates must remain within `Pressure Cp Range` of PV1.

Relevant options:

- `Pressure Mode` (`false` by default)
- `Pressure MultiPV` (`5` by default)
- `Pressure Cp Range` (`80` by default)

### Hunter Mode

`Hunter Mode` watches for a position where the engine is ahead by a threshold derived from the player's training mistake threshold:

```text
trigger = Player Mistake Threshold × Hunter Multiplier / 100
```

Defaults make a 200cp training threshold trigger hunter state at 100cp. When active, the picker tightens the allowed loss from PV1, increases tactical weighting, and reduces randomness for a configurable number of engine moves.

Relevant options:

- `Hunter Mode` (`false` by default)
- `Hunter Multiplier` (`50` by default)
- `Hunter Moves` (`3` by default)
- `Player Mistake Threshold` (`200` by default)

### Closer Mode

`Closer Mode` changes root-selection preferences according to the top root score:

- Clearly winning: allow safe conversion choices and favor captures/simplification inside the candidate range.
- Slightly ahead: preserve initiative and pressure.
- Equal: prefer forcing or tactically uncomfortable moves.
- Losing: prefer checks/captures and practical counterplay.

Relevant option:

- `Closer Mode` (`false` by default)

## Interaction model

The modes stack. Enabling any mode raises the internal root MultiPV requirement to at least `Pressure MultiPV`, then the final root move is chosen by the combined weighting layer. The layer never removes PV1 from the pool and uses a large PV1 base weight so the best move remains frequent.
