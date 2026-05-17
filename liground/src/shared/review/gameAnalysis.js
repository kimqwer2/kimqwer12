const PHASES = [
  { key: 'opening', label: 'Opening', range: [1, 30], color: '#7289da' },
  { key: 'middlegame', label: 'Middlegame', range: [31, 70], color: '#f2994a' },
  { key: 'endgame', label: 'Endgame', range: [71, Infinity], color: '#2f855a' }
]

function clamp (value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value))
}

function average (values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function stdDev (values) {
  if (!values.length) return 0
  const avg = average(values)
  return Math.sqrt(average(values.map(value => Math.pow(value - avg, 2))))
}

function qualityFromAcpl (acpl) {
  return clamp(100 - (Number(acpl) || 0) * 0.75)
}

function scoreLabel (score, high = '높음', mid = '보통', low = '낮음') {
  if (score >= 72) return high
  if (score >= 42) return mid
  return low
}

function normalizeMove (move) {
  const loss = typeof move.loss === 'number' ? Math.max(0, move.loss) : 80
  const top1 = move.move && move.bestMove ? move.move === move.bestMove : loss <= 20
  const top3 = top1 || loss <= 75
  const tactical = Boolean(move.practical && (move.practical.attackChances || move.practical.complexityIncrease || move.practical.initiative))
  const defensive = Boolean(move.practical && move.practical.defensiveConcern)
  const riskCount = Array.isArray(move.risks) ? move.risks.length : 0
  return {
    ...move,
    loss,
    top1,
    top3,
    tactical,
    defensive,
    riskCount,
    phase: phaseForPly(move.ply || 1)
  }
}

function phaseForPly (ply) {
  return PHASES.find(phase => ply >= phase.range[0] && ply <= phase.range[1]) || PHASES[PHASES.length - 1]
}

function statsForMoves (moves) {
  const losses = moves.map(move => move.loss)
  const total = Math.max(1, moves.length)
  return {
    acpl: average(losses),
    top1: moves.filter(move => move.top1).length / total * 100,
    top3: moves.filter(move => move.top3).length / total * 100,
    perfect: moves.filter(move => move.loss <= 5).length,
    inaccuracy: moves.filter(move => move.loss >= 50 && move.loss < 100).length,
    mistake: moves.filter(move => move.loss >= 100 && move.loss < 200).length,
    blunder: moves.filter(move => move.loss >= 200).length,
    stdDev: stdDev(losses),
    criticalTop1: moves.filter(move => move.riskCount || (move.loss >= 30 && move.loss < 130)).filter(move => move.top1).length / Math.max(1, moves.filter(move => move.riskCount || (move.loss >= 30 && move.loss < 130)).length) * 100,
    unforcedTop1: moves.filter(move => move.top1).length / total * 100,
    unforcedAcpl: average(losses)
  }
}

function phaseBreakdown (moves) {
  return PHASES.map(phase => {
    const phaseMoves = moves.filter(move => move.phase.key === phase.key)
    const acpl = phaseMoves.length ? average(phaseMoves.map(move => move.loss)) : null
    const quality = acpl === null ? 0 : qualityFromAcpl(acpl)
    return {
      ...phase,
      count: phaseMoves.length,
      acpl,
      quality,
      volatility: stdDev(phaseMoves.map(move => move.loss))
    }
  })
}

function bestWindowAcpl (moves, size = 10) {
  if (moves.length < size) return null
  let best = Infinity
  for (let idx = 0; idx <= moves.length - size; idx++) {
    best = Math.min(best, average(moves.slice(idx, idx + size).map(move => move.loss)))
  }
  return Number.isFinite(best) ? best : null
}

function recoveryRate (moves) {
  let opportunities = 0
  let recoveries = 0
  for (let idx = 0; idx < moves.length; idx++) {
    if (moves[idx].loss >= 200) {
      const next = moves.slice(idx + 1, idx + 4)
      if (next.length === 3) {
        opportunities++
        if (average(next.map(move => move.loss)) <= 20) recoveries++
      }
    }
  }
  return opportunities ? recoveries / opportunities * 100 : null
}

function analyzerMetrics (moves, stats, phases) {
  const total = Math.max(1, moves.length)
  const tacticalCount = moves.filter(move => move.tactical).length
  const defensiveCount = moves.filter(move => move.defensive).length
  const riskyCount = moves.filter(move => move.riskCount || move.loss >= 130).length
  const practicalGood = moves.filter(move => move.tactical && move.loss <= 80).length
  const late = phases.find(phase => phase.key === 'endgame')
  const recovery = recoveryRate(moves)
  const bestWindow = bestWindowAcpl(moves)

  const tacticalDependence = clamp((tacticalCount / total) * 100 + stats.criticalTop1 * 0.25)
  const positionalPreference = clamp(100 - tacticalDependence * 0.55 - stats.stdDev * 0.7 + stats.top3 * 0.25)
  const aggression = clamp((tacticalCount / total) * 80 + riskyCount / total * 65 + moves.filter(move => move.practical && move.practical.initiative).length / total * 45)
  const stability = clamp(100 - stats.stdDev * 1.7 - stats.blunder * 10 + stats.top3 * 0.18)
  const practicality = clamp(practicalGood / Math.max(1, tacticalCount) * 70 + stats.top3 * 0.25)
  const riskProfile = clamp(riskyCount / total * 75 + stats.blunder * 8 + stats.stdDev * 0.75)
  const strategicSharpness = clamp(stats.criticalTop1 * 0.45 + tacticalDependence * 0.35 + (bestWindow === null ? 30 : qualityFromAcpl(bestWindow)) * 0.2)
  const conversionQuality = late && late.count ? late.quality : clamp(100 - stats.acpl * 0.65)
  const defensiveResilience = recovery === null ? clamp(100 - defensiveCount / total * 10 - stats.blunder * 8) : recovery
  const engineLike = clamp(stats.top1 * 0.45 + stats.top3 * 0.25 + (100 - stats.unforcedAcpl) * 0.2 + (100 - stats.stdDev * 2) * 0.1)
  const humanPractical = clamp(practicality * 0.45 + aggression * 0.2 + riskProfile * 0.15 + (100 - engineLike) * 0.2)

  return {
    tacticalDependence,
    positionalPreference,
    aggression,
    stability,
    consistency: stability,
    practicality,
    riskProfile,
    strategicSharpness,
    conversionQuality,
    defensiveResilience,
    engineLike,
    humanPractical,
    bestWindowAcpl: bestWindow,
    hardPositionTop1: stats.criticalTop1,
    recoveryRate: recovery
  }
}

function styleNarratives (metrics) {
  const narratives = []
  if (metrics.tacticalDependence >= 68) narratives.push('Highly tactical style: 복잡한 전술/난전 구간에서 선택이 집중됩니다.')
  if (metrics.positionalPreference >= 68) narratives.push('Strategic pressure-oriented play: 직접 전술보다 구조와 압박을 선호합니다.')
  if (metrics.engineLike >= 72) narratives.push('Engine-like conversion tendency: 유리함을 유지하는 선택이 안정적으로 반복됩니다.')
  if (metrics.humanPractical >= 64) narratives.push('Human practical compensation preference: 완전한 엔진 최선보다 실전 보상과 복잡성을 적극 활용합니다.')
  if (metrics.defensiveResilience >= 70) narratives.push('Defensive resilience: 손상된 국면 이후에도 무너지지 않고 회복하는 경향이 있습니다.')
  if (metrics.riskProfile >= 70) narratives.push('High-risk profile: 실전 승부수와 평가 손실 가능성이 함께 나타납니다.')
  if (!narratives.length) narratives.push('Balanced practical style: 전술, 포지션, 안정성 사이의 균형형 흐름입니다.')
  return narratives
}

function similarity (metrics) {
  return [
    { key: 'engineLike', label: 'Engine-like similarity', value: metrics.engineLike, text: scoreLabel(metrics.engineLike, '기계적 정밀도 높음', '고수형 정확도', '인간적 편차 큼') },
    { key: 'humanPractical', label: 'Human practical similarity', value: metrics.humanPractical, text: scoreLabel(metrics.humanPractical, '실전 보상 선호 강함', '실전 균형형', '건조한 엔진형') },
    { key: 'tactical', label: 'Tactical similarity', value: metrics.tacticalDependence, text: scoreLabel(metrics.tacticalDependence, '전술 의존 높음', '전술 균형', '전술 의존 낮음') },
    { key: 'positional', label: 'Positional similarity', value: metrics.positionalPreference, text: scoreLabel(metrics.positionalPreference, '포지션 지향', '혼합형', '직접 전술 지향') },
    { key: 'aggressive', label: 'Aggressive style similarity', value: metrics.aggression, text: scoreLabel(metrics.aggression, '공격적/난전형', '균형형', '안정 지향') },
    { key: 'defensive', label: 'Defensive style similarity', value: metrics.defensiveResilience, text: scoreLabel(metrics.defensiveResilience, '수비 복원력 높음', '수비 보통', '흔들림 있음') }
  ]
}

export function analyzeGameReview (reviewResult) {
  const sourceMoves = reviewResult && Array.isArray(reviewResult.moves) ? reviewResult.moves : []
  const moves = sourceMoves.map(normalizeMove)
  if (!moves.length) return null
  const stats = statsForMoves(moves)
  const phases = phaseBreakdown(moves)
  const metrics = analyzerMetrics(moves, stats, phases)
  return {
    generatedAt: Date.now(),
    source: 'fjace_analyzer_all7.py-inspired bridge',
    moveCount: moves.length,
    stats,
    phases,
    metrics,
    similarity: similarity(metrics),
    narratives: styleNarratives(metrics),
    summary: `${scoreLabel(metrics.engineLike, '엔진 유사도가 높은', '정교하지만 인간적인', '실전적 편차가 큰')} 흐름이며, ${scoreLabel(metrics.tacticalDependence, '전술적 복잡성', '균형 잡힌 선택', '포지션 운영')}이 두드러집니다. 안정성은 ${scoreLabel(metrics.stability, '높은 편', '보통', '불안정')}입니다.`,
    terms: [
      'ACPL/편차/Top 일치율/구간 분석은 fjace_analyzer_all7.py의 통계 철학을 UI 데이터에 맞게 재해석한 것입니다.',
      '비강제수·난전 Top-1·회복률 같은 지표는 부정행위 판정이 아니라 스타일과 안정성 해석용 참고 신호입니다.'
    ]
  }
}

export function phaseRingStyle (phases) {
  const fallback = 'conic-gradient(#555 0deg 360deg)'
  if (!Array.isArray(phases) || phases.length < 3) return { background: fallback }
  const alpha = phase => 0.18 + (phase.quality / 100) * 0.82
  return {
    background: `conic-gradient(rgba(114,137,218,${alpha(phases[0])}) 0deg 120deg, rgba(242,153,74,${alpha(phases[1])}) 120deg 240deg, rgba(47,133,90,${alpha(phases[2])}) 240deg 360deg)`
  }
}
