/**
 * Coordinate helpers used by the human-review layer.
 *
 * liground and Fairy-Stockfish sometimes disagree on whether Janggi ranks are
 * zero-based or one-based. Keep conversion in one review-layer utility so the
 * UI, IPC service, and future feature analyzers do not duplicate ad-hoc logic.
 */
export function toFairyStockfishJanggiUci (uci) {
  if (typeof uci !== 'string') return uci
  return uci.replace(/^([a-i])(\d+)([a-i])(\d+)$/, (_, of, orank, df, drank) => `${of}${Number(orank) + 1}${df}${Number(drank) + 1}`)
}

export function fromFairyStockfishJanggiUci (uci) {
  if (typeof uci !== 'string') return uci
  return uci.replace(/^([a-i])(\d+)([a-i])(\d+)$/, (_, of, orank, df, drank) => `${of}${Number(orank) - 1}${df}${Number(drank) - 1}`)
}

export function splitUciMove (uci) {
  if (typeof uci !== 'string') return null
  const match = uci.match(/^([a-i]\d{1,2})([a-i]\d{1,2})/)
  if (!match) return null
  return { orig: match[1], dest: match[2] }
}
