export const REVIEW_SCHEMA_VERSION = 1
export const REVIEW_SERVICE_VERSION = 'human-review-v1'

export const REVIEW_MODES = Object.freeze({
  MOVE: 'move',
  CUSTOM_MOVE: 'custom_move',
  LINE: 'line'
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
    lastMove: null
  }
}

export function emptyReviewState () {
  return {
    active: false,
    loading: false,
    error: null,
    currentResult: null,
    resultsById: {},
    overlays: [],
    lastRequestId: null,
    sequence: emptyReviewSequenceState()
  }
}

export function createReviewRequest ({ id, mode, variant, fen, move, moveSan, line, multipv, engineName, context }) {
  return {
    id,
    schemaVersion: REVIEW_SCHEMA_VERSION,
    serviceVersion: REVIEW_SERVICE_VERSION,
    mode: mode || REVIEW_MODES.MOVE,
    variant: variant || 'janggi',
    fen: fen || '',
    move: move || '',
    moveSan: moveSan || '',
    line: Array.isArray(line) ? line : (move ? [move] : []),
    multipv: Array.isArray(multipv) ? multipv : [],
    engineName: engineName || '',
    context: context || {},
    createdAt: Date.now()
  }
}
