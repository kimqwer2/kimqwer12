export const REVIEW_SCHEMA_VERSION = 1
export const REVIEW_SERVICE_VERSION = 'human-review-v4'

export const REVIEW_MODES = Object.freeze({
  MOVE: 'move',
  CUSTOM_MOVE: 'custom_move',
  LINE: 'line'
})

export const REVIEW_MARKER_MODES = Object.freeze({
  FIRST_MOVE_ONLY: 'FIRST_MOVE_ONLY',
  MY_MOVES_ONLY: 'MY_MOVES_ONLY',
  OPPONENT_MOVES_ONLY: 'OPPONENT_MOVES_ONLY',
  BOTH_SIDES: 'BOTH_SIDES'
})

export const REVIEW_OVERLAY_KINDS = Object.freeze({
  ARROW: 'arrow',
  HIGHLIGHT: 'highlight',
  DANGER: 'danger'
})

export const REVIEW_BRUSHES = Object.freeze({
  IDEA: 'blue',
  ATTACK: 'orange',
  DANGER: 'red',
  BEST: 'yellow',
  SUPPORT: 'green',
  NEUTRAL: 'paleBlue'
})

export function emptyReviewSequenceState () {
  return {
    active: false,
    baseFen: '',
    fen: '',
    turn: true,
    legalMoves: '',
    line: [],
    sans: [],
    overlays: [],
    lastMove: null,
    previousInteraction: {
      analysisMode: null,
      editorMode: null
    }
  }
}

export function emptyReviewState () {
  return {
    active: false,
    markerMode: REVIEW_MARKER_MODES.MY_MOVES_ONLY,
    loading: false,
    error: null,
    currentResult: null,
    resultsById: {},
    overlays: [],
    preview: {
      active: false,
      fen: '',
      move: null,
      overlays: []
    },
    lastRequestId: null,
    sequence: emptyReviewSequenceState()
  }
}

export function createReviewRequest ({ id, mode, markerMode, variant, fen, move, moveSan, line, multipv, engineName, engineAnalysis, context }) {
  return {
    id,
    schemaVersion: REVIEW_SCHEMA_VERSION,
    serviceVersion: REVIEW_SERVICE_VERSION,
    mode: mode || REVIEW_MODES.MOVE,
    markerMode: markerMode || (context && context.markerMode) || REVIEW_MARKER_MODES.MY_MOVES_ONLY,
    variant: variant || 'janggi',
    fen: fen || '',
    move: move || '',
    moveSan: moveSan || '',
    line: Array.isArray(line) ? line : (move ? [move] : []),
    multipv: Array.isArray(multipv) ? multipv : [],
    engineName: engineName || '',
    engineAnalysis: engineAnalysis || null,
    context: context || {},
    createdAt: Date.now()
  }
}
