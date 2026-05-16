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
