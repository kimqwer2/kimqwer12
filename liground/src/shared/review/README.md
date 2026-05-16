# Human Review Layer

This folder contains the renderer/main-process shared contract for the human-style
review system. The review layer is intentionally separate from engine MultiPV
state and from Fairy-Stockfish internals.

## Request flow

1. Renderer Vuex actions create a request with `createReviewRequest`.
2. The request is sent over Electron IPC with `review-analyze`.
3. The main process calls `analyzeReviewRequest` and stores results in the
   separate `review-cache.db` cache.
4. Vuex stores the returned result under `state.review`.
5. `ChessGround.vue` renders `result.overlays` in addition to existing MultiPV
   overlays.

## Result shape

Review results are structured JSON:

- `summary`: human-readable coaching text.
- `classification`: stable machine-readable label.
- `engineEvidence`: optional engine-backed facts used as evidence.
- `ideas`: inferred human ideas with confidence values.
- `risks`: tactical or positional concerns with confidence values.
- `alternatives`: candidate moves or plans to compare.
- `overlays`: board annotations such as arrows, highlights, and danger markers.

## Overlay shape

Overlays are UI-neutral objects:

- `kind`: `arrow`, `highlight`, or `danger`.
- `orig` / `dest`: UCI-style squares for arrows.
- `square`: UCI-style square for highlights.
- `brush`: chessground brush name such as `red`, `orange`, `blue`, or `yellow`.
- `label`: optional short label rendered by chessgroundx.
- `modifiers`: optional drawing modifiers such as `lineWidth` and `opacity`.

## Coordinate policy

Janggi coordinate conversion belongs in `janggiCoordinates.js`, not in the
engine and not duplicated in UI components. Future feature analyzers should use
that module when converting between liground and Fairy-Stockfish conventions.

## Interactive sequence review

The renderer keeps temporary sequence-review state under `state.review.sequence`.
When active, `ChessGround.vue` selects a single `BoardInteractionMode` and gives
`REVIEW_SEQUENCE` its own source-of-truth FEN, side to move, legal move list,
last-move marker, and overlays. Board moves are routed to
`addReviewSequenceMove` instead of the normal game-history `push` action. The
temporary board FEN, legal moves, SAN labels, UCI line, and path overlays are
updated in the review state only, so the actual game tree and engine MultiPV
remain untouched. Starting a review sequence temporarily leaves board-editor
free-move mode and restores the previous editor/analysis flags when review mode
ends.

Sequence review requests send the sequence base FEN plus the played temporary
line to `review-analyze`. The review service treats the line as a candidate idea
and returns path overlays, feature-derived intent, risk labels, and key moments.

## Engine-backed evidence

Before a review request is sent to the shared review service, the renderer asks
the existing eval worker for a bounded review search. The worker searches the
review root FEN, optionally searches the user's first move with `searchmoves`,
and searches the final temporary-sequence position for an opponent reply. The
returned evidence is attached as `engineAnalysis` and used by the review service
for recommendation lists, eval-loss estimates, and punishment arrows.

The engine remains a pure UCI search provider; all commentary, intent labels,
risk summaries, and overlays are produced in the review layer.
