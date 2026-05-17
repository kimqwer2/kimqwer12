const PHASES = [
  { key: 'opening', label: '초반', range: [1, 30], color: '#7289da' },
  { key: 'middlegame', label: '중반', range: [31, 70], color: '#f2994a' },
  { key: 'endgame', label: '종반', range: [71, Infinity], color: '#2f855a' }
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

function koreanScoreLabel (score, high = '높음', mid = '보통', low = '낮음') {
  if (score >= 72) return high
  if (score >= 42) return mid
  return low
}

function phaseForPly (ply) {
  return PHASES.find(phase => ply >= phase.range[0] && ply <= phase.range[1]) || PHASES[PHASES.length - 1]
}

function sideKeyForPly (ply) {
  return Number(ply) % 2 === 1 ? 'cho' : 'han'
}

function sideLabelForMove (move, ply) {
  if (move && move.sideLabel === '초') return '초'
  if (move && move.sideLabel === '한') return '한'
  return sideKeyForPly(ply) === 'cho' ? '초' : '한'
}

function sourceLabel (move) {
  return move.name || move.move || move.uci || '해당 수'
}

function moveVector (uci) {
  const match = typeof uci === 'string' ? uci.match(/^([a-i])(\d+)([a-i])(\d+)$/) : null
  if (!match) return { fileDelta: 0, rankDelta: 0, distance: 0 }
  const fileDelta = match[3].charCodeAt(0) - match[1].charCodeAt(0)
  const rankDelta = Number(match[4]) - Number(match[2])
  return { fileDelta, rankDelta, distance: Math.abs(fileDelta) + Math.abs(rankDelta) }
}

function liveMoveSignals (move) {
  const vector = moveVector(move.uci || move.move)
  const name = move.name || move.move || move.uci || ''
  const centerFile = /[def]/.test(name) || /[def]/.test(move.uci || '')
  const longStep = vector.distance >= 3
  const palaceOrCenter = centerFile || Math.abs(vector.fileDelta) >= 2
  return {
    tactical: longStep || /x|\+|#/.test(name),
    defensive: Math.abs(vector.rankDelta) <= 1 && Math.abs(vector.fileDelta) <= 1,
    initiative: vector.rankDelta > 0 || longStep,
    complexity: longStep || palaceOrCenter,
    heuristicLoss: longStep ? 58 : (palaceOrCenter ? 42 : 34)
  }
}

function normalizeMove (move, source = 'review') {
  const live = liveMoveSignals(move)
  const hasEngineLoss = typeof move.loss === 'number'
  const loss = hasEngineLoss ? Math.max(0, move.loss) : live.heuristicLoss
  const top1 = hasEngineLoss ? (move.move && move.bestMove ? move.move === move.bestMove : loss <= 20) : loss <= 35
  const top3 = hasEngineLoss ? (top1 || loss <= 75) : loss <= 60
  const tactical = Boolean(move.practical && (move.practical.attackChances || move.practical.complexityIncrease || move.practical.initiative)) || live.tactical
  const defensive = Boolean(move.practical && move.practical.defensiveConcern) || live.defensive
  const riskCount = Array.isArray(move.risks) ? move.risks.length : 0
  return {
    ...move,
    move: move.move || move.uci || '',
    loss,
    hasEngineLoss,
    top1,
    top3,
    tactical,
    defensive,
    initiative: Boolean(move.practical && move.practical.initiative) || live.initiative,
    complexity: Boolean(move.practical && move.practical.complexityIncrease) || live.complexity,
    riskCount,
    source,
    sideKey: sideKeyForPly(move.ply || 1),
    sideLabel: sideLabelForMove(move, move.ply || 1),
    phase: phaseForPly(move.ply || 1)
  }
}

function statsForMoves (moves) {
  const losses = moves.map(move => move.loss)
  const total = Math.max(1, moves.length)
  const critical = moves.filter(move => move.riskCount || (move.loss >= 30 && move.loss < 130) || move.complexity)
  return {
    acpl: average(losses),
    top1: moves.filter(move => move.top1).length / total * 100,
    top3: moves.filter(move => move.top3).length / total * 100,
    perfect: moves.filter(move => move.loss <= 5).length,
    inaccuracy: moves.filter(move => move.loss >= 50 && move.loss < 100).length,
    mistake: moves.filter(move => move.loss >= 100 && move.loss < 200).length,
    blunder: moves.filter(move => move.loss >= 200).length,
    stdDev: stdDev(losses),
    criticalTop1: critical.filter(move => move.top1).length / Math.max(1, critical.length) * 100,
    unforcedTop1: moves.filter(move => move.top1).length / total * 100,
    unforcedAcpl: average(losses),
    engineBackedRatio: moves.filter(move => move.hasEngineLoss).length / total * 100
  }
}

function phaseBreakdown (moves) {
  return PHASES.map(phase => {
    const phaseMoves = moves.filter(move => move.phase.key === phase.key)
    const acpl = phaseMoves.length ? average(phaseMoves.map(move => move.loss)) : null
    const quality = acpl === null ? 0 : qualityFromAcpl(acpl)
    const tacticalRate = phaseMoves.filter(move => move.tactical).length / Math.max(1, phaseMoves.length) * 100
    const riskRate = phaseMoves.filter(move => move.riskCount || move.loss >= 100).length / Math.max(1, phaseMoves.length) * 100
    return {
      ...phase,
      count: phaseMoves.length,
      acpl,
      quality,
      volatility: stdDev(phaseMoves.map(move => move.loss)),
      tacticalRate,
      riskRate
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
    if (moves[idx].loss >= 200 || moves[idx].riskCount >= 2) {
      const next = moves.slice(idx + 1, idx + 4)
      if (next.length === 3) {
        opportunities++
        if (average(next.map(move => move.loss)) <= 40) recoveries++
      }
    }
  }
  return opportunities ? recoveries / opportunities * 100 : null
}

function analyzerMetrics (moves, stats, phases) {
  const total = Math.max(1, moves.length)
  const tacticalCount = moves.filter(move => move.tactical).length
  const initiativeCount = moves.filter(move => move.initiative).length
  const defensiveCount = moves.filter(move => move.defensive).length
  const riskyCount = moves.filter(move => move.riskCount || move.loss >= 130).length
  const practicalGood = moves.filter(move => move.tactical && move.loss <= 80).length
  const late = phases.find(phase => phase.key === 'endgame')
  const recovery = recoveryRate(moves)
  const bestWindow = bestWindowAcpl(moves)

  const tacticalDependence = clamp((tacticalCount / total) * 100 + stats.criticalTop1 * 0.25)
  const positionalPreference = clamp(100 - tacticalDependence * 0.55 - stats.stdDev * 0.7 + stats.top3 * 0.25)
  const aggression = clamp((tacticalCount / total) * 70 + riskyCount / total * 55 + initiativeCount / total * 40)
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

function phaseTransitionNarrative (phases) {
  const [opening, middle, endgame] = phases
  const lines = []
  if (opening.count && middle.count) {
    const delta = middle.tacticalRate - opening.tacticalRate
    if (delta >= 18) lines.push('초반에는 비교적 차분하게 진영을 갖췄지만, 중반 이후 강제 계산과 직접 압박의 비중이 뚜렷하게 올라갑니다.')
    else if (delta <= -18) lines.push('중반으로 넘어가며 무리한 전술보다 구조 안정과 실전적인 수습을 우선하는 방향으로 흐름이 바뀝니다.')
    else lines.push('초반에서 중반으로 넘어가는 과정의 성향 변화는 크지 않고, 선택 리듬이 비교적 일관됩니다.')
  }
  if (middle.count && endgame.count) {
    const qualityDelta = endgame.quality - middle.quality
    if (qualityDelta >= 15) lines.push('종반부에서는 중반의 복잡성을 정리하면서 전환 이후의 수습 능력이 좋아지는 모습입니다.')
    else if (qualityDelta <= -15) lines.push('중반의 압박을 종반까지 안정적으로 변환하지 못해, 후속 정리 과정에서 효율이 떨어지는 구간이 보입니다.')
  }
  return lines
}

function eventSeverity (event) {
  const order = { critical: 3, warning: 2, recovery: 1, info: 0 }
  return order[event.severity] || 0
}

function criticalEvents (moves) {
  const events = []
  for (let idx = 0; idx < moves.length; idx++) {
    const cur = moves[idx]
    const prev = idx > 0 ? moves[idx - 1] : null
    const sideMoves = moves.filter(move => move.sideKey === cur.sideKey)
    const sideIndex = sideMoves.findIndex(move => move.ply === cur.ply)
    const previousSide = sideIndex > 0 ? sideMoves[sideIndex - 1] : null
    const nextSide = sideMoves.slice(sideIndex + 1, sideIndex + 3)
    const jump = prev ? cur.loss - prev.loss : 0
    const sideJump = previousSide ? cur.loss - previousSide.loss : 0
    const recovered = nextSide.length > 0 && average(nextSide.map(move => move.loss)) <= 45
    const stabilized = nextSide.length >= 2 && nextSide.every(move => move.loss < 90)
    const moveName = sourceLabel(cur)
    const phaseLabel = cur.phase ? cur.phase.label : '해당 구간'

    if (cur.loss >= 220) {
      events.push({
        type: 'collapse',
        severity: 'critical',
        ply: cur.ply,
        sideKey: cur.sideKey,
        sideLabel: cur.sideLabel,
        loss: cur.loss,
        title: `${cur.sideLabel} ${cur.ply}수 붕괴 지점`,
        text: `${phaseLabel} ${cur.ply}수 ${moveName} 이후 평가 손실이 크게 벌어졌습니다. 이 장면이 형세가 무너진 핵심 전환점이며, ${recovered ? '후속 수순에서 일부 수습은 이루어졌지만 손상된 구조를 완전히 복구했는지 확인이 필요합니다.' : '이후 안정화 신호가 약해 수비 구조와 계산 정확도가 함께 흔들린 것으로 보입니다.'}`
      })
    } else if (cur.loss >= 130) {
      events.push({
        type: 'mistake',
        severity: 'warning',
        ply: cur.ply,
        sideKey: cur.sideKey,
        sideLabel: cur.sideLabel,
        loss: cur.loss,
        title: `${cur.sideLabel} ${cur.ply}수 불안정`,
        text: `${cur.ply}수 ${moveName}에서 손실이 커졌습니다. 한 번의 전술 착오라기보다 후보수 검증이 부족해 다음 국면의 방어 부담이 증가한 장면입니다.`
      })
    }

    if (jump >= 90 || sideJump >= 110) {
      events.push({
        type: 'swing',
        severity: jump >= 150 || sideJump >= 180 ? 'critical' : 'warning',
        ply: cur.ply,
        sideKey: cur.sideKey,
        sideLabel: cur.sideLabel,
        loss: cur.loss,
        title: `${cur.sideLabel} ${cur.ply}수 평가 급변`,
        text: `${cur.ply}수 부근에서 엔진 동의도가 급격히 낮아지며 흐름이 바뀌었습니다. 이 수 이후부터 ${cur.defensive || cur.riskCount ? '수비 구조가 흔들리고' : '계산 의존도가 높아지고'}, 복잡한 변화를 정확히 통제해야 하는 부담이 커졌습니다.`
      })
    }

    if (jump <= -80 || sideJump <= -100) {
      events.push({
        type: 'recovery',
        severity: 'recovery',
        ply: cur.ply,
        sideKey: cur.sideKey,
        sideLabel: cur.sideLabel,
        loss: cur.loss,
        title: `${cur.sideLabel} ${cur.ply}수 회복 시도`,
        text: `${cur.ply}수 이후 이전의 불안정성이 완화됩니다. ${stabilized ? '후속 수순도 비교적 안정되어 실전적인 수습에 성공한 흐름입니다.' : '다만 곧바로 완전히 안정되지는 않아 추가적인 방어 정확도가 필요했습니다.'}`
      })
    }

    if (cur.tactical && cur.loss >= 120) {
      events.push({
        type: 'failed_attack',
        severity: cur.loss >= 200 ? 'critical' : 'warning',
        ply: cur.ply,
        sideKey: cur.sideKey,
        sideLabel: cur.sideLabel,
        loss: cur.loss,
        title: `${cur.sideLabel} 공격 불안정`,
        text: `${cur.ply}수 ${moveName}는 공격적 의도나 복잡성은 있었지만 실제 형세는 불안정해졌습니다. 공격은 지속되었으나 엔진 관점에서는 보상보다 노출된 약점이 더 크게 평가된 장면입니다.`
      })
    }

    if ((cur.defensive || cur.riskCount >= 2) && cur.loss >= 110) {
      events.push({
        type: 'defensive_breakdown',
        severity: cur.loss >= 200 ? 'critical' : 'warning',
        ply: cur.ply,
        sideKey: cur.sideKey,
        sideLabel: cur.sideLabel,
        loss: cur.loss,
        title: `${cur.sideLabel} 수비 균열`,
        text: `${cur.ply}수에서 방어 관련 리스크가 커졌습니다. 이 수 이후부터 수비 구조가 흔들리기 시작했고, 상대의 후속 압박을 정리하기 어려운 형태로 전환되었습니다.`
      })
    }
  }

  for (const sideKey of ['cho', 'han']) {
    const sideMoves = moves.filter(move => move.sideKey === sideKey)
    for (let idx = 0; idx <= sideMoves.length - 3; idx++) {
      const window = sideMoves.slice(idx, idx + 3)
      if (window.every(move => move.loss >= 70 || move.riskCount)) {
        events.push({
          type: 'consecutive_inaccuracies',
          severity: 'warning',
          ply: window[0].ply,
          sideKey,
          sideLabel: window[0].sideLabel,
          loss: average(window.map(move => move.loss)),
          title: `${window[0].sideLabel} 연속 부정확`,
          text: `${window[0].ply}수부터 ${window[2].ply}수까지 작은 손실과 리스크가 연속으로 누적되었습니다. 즉각적인 붕괴보다 운영 리듬이 흐트러지며 안정성이 낮아진 구간입니다.`
        })
        break
      }
    }
  }

  return events
    .sort((a, b) => eventSeverity(b) - eventSeverity(a) || b.loss - a.loss || a.ply - b.ply)
    .slice(0, 8)
}

function turningPoints (moves) {
  const events = criticalEvents(moves)
  if (events.length) return events.slice(0, 4).map(event => event.text)
  if (moves.length >= 6) return ['뚜렷한 급락보다 작은 선택들이 누적되는 흐름입니다. 이런 유형은 한 수의 전술보다 장기적인 활동성과 진형 효율을 함께 봐야 합니다.']
  return []
}

function styleNarratives (metrics, phases, moves, isLive, events = []) {
  const narratives = []
  const critical = events.find(event => event.severity === 'critical')
  const recovery = events.find(event => event.type === 'recovery')
  if (critical) narratives.push(`${critical.title}: ${critical.text}`)
  if (metrics.tacticalDependence >= 68) narratives.push('전술 의존도가 높습니다. 복잡한 국면에서 후보수를 넓히기보다 계산이 되는 강제 흐름을 붙잡고 주도권을 이어가려는 성향이 강합니다.')
  if (metrics.positionalPreference >= 68) narratives.push('포지션 지향성이 분명합니다. 당장의 전술보다 장기적인 활동성, 진형의 탄력, 다음 압박 지점을 준비하는 선택이 자주 나타납니다.')
  if (metrics.engineLike >= 72 && !critical) narratives.push('유리한 흐름을 유지하는 방식이 상당히 정교합니다. 큰 흔들림 없이 평가를 보존하는 선택이 반복되어 엔진식 전환 감각과 닮은 부분이 있습니다.')
  if (metrics.humanPractical >= 64) narratives.push('실전적 보상 선호가 보입니다. 최선 수의 건조한 유지보다 상대가 계속 어려운 결정을 하도록 복잡성과 압박을 남겨두는 쪽에 가깝습니다.')
  if (metrics.defensiveResilience >= 70 && !critical) narratives.push('수비 복원력이 좋습니다. 불리하거나 복잡한 장면 이후에도 바로 무너지지 않고, 다음 몇 수 안에 균형을 되찾는 패턴이 보입니다.')
  if (metrics.riskProfile >= 70) narratives.push('위험 감수 성향이 큽니다. 다만 이것은 단순히 나쁜 수가 많다는 뜻이 아니라, 형세를 흔들어 실전적 기회를 만들려는 선택이 섞여 있다는 의미에 가깝습니다.')
  if (recovery) narratives.push(recovery.text)
  if (isLive) narratives.push('현재 리포트는 진행 중인 기보의 수순 구조를 기반으로 한 라이브 해석입니다. 엔진 리뷰가 누적되면 손실·회복·유사도 판단이 더 정밀해집니다.')
  narratives.push(...phaseTransitionNarrative(phases))
  narratives.push(...turningPoints(moves).filter(line => !narratives.includes(line)))
  if (!narratives.length) narratives.push('전술, 포지션, 안정성 사이의 균형이 비교적 잘 유지됩니다. 한쪽 성향으로 극단적으로 치우치기보다는 국면에 맞춰 선택을 조절하는 흐름입니다.')
  return narratives
}

function sideNarratives (side, events) {
  const lines = []
  const sideEvents = events.filter(event => event.sideKey === side.key)
  const critical = sideEvents.find(event => event.severity === 'critical')
  const warning = sideEvents.find(event => event.severity === 'warning')
  const recovery = sideEvents.find(event => event.type === 'recovery')
  if (critical) lines.push(critical.text)
  else if (warning) lines.push(warning.text)
  if (side.metrics.aggression >= 68) lines.push(`${side.label}는 주도권을 직접 밀어붙이는 비중이 높았습니다. 다만 안정성 점수와 함께 보면 공격이 실제 평가를 지켰는지 분리해서 봐야 합니다.`)
  if (side.metrics.stability < 45) lines.push(`${side.label}의 안정성은 낮은 편입니다. 큰 실수 하나뿐 아니라 손실 편차가 커서 국면마다 판단 품질이 흔들렸습니다.`)
  if (side.metrics.defensiveResilience >= 65) lines.push(`${side.label}는 흔들린 뒤에도 비교적 빠르게 자세를 고쳐 잡는 수습 능력이 보입니다.`)
  if (recovery) lines.push(recovery.text)
  if (!lines.length) lines.push(`${side.label}는 전술, 운영, 안정성 사이에서 비교적 균형 잡힌 흐름을 보였습니다.`)
  return lines.slice(0, 4)
}

function buildSideAnalysis (moves, events) {
  return ['cho', 'han'].map(key => {
    const sideMoves = moves.filter(move => move.sideKey === key)
    const stats = statsForMoves(sideMoves)
    const phases = phaseBreakdown(sideMoves)
    const metrics = analyzerMetrics(sideMoves, stats, phases)
    const side = {
      key,
      label: key === 'cho' ? '초' : '한',
      moveCount: sideMoves.length,
      stats,
      phases,
      metrics,
      similarity: similarity(metrics),
      events: events.filter(event => event.sideKey === key).slice(0, 4)
    }
    side.narratives = sideNarratives(side, events)
    return side
  })
}

function comparativeNarratives (sides, events) {
  const [cho, han] = sides
  const lines = []
  if (!cho || !han) return lines
  const aggressionGap = cho.metrics.aggression - han.metrics.aggression
  const stabilityGap = cho.metrics.stability - han.metrics.stability
  const engineGap = cho.metrics.engineLike - han.metrics.engineLike
  if (Math.abs(aggressionGap) >= 15) lines.push(`${aggressionGap > 0 ? '초' : '한'}는 더 직접적인 압박과 공격적 선택을 많이 보였고, ${aggressionGap > 0 ? '한' : '초'}는 상대적으로 운영·수습 비중이 높았습니다.`)
  if (Math.abs(stabilityGap) >= 15) lines.push(`${stabilityGap > 0 ? '초' : '한'}의 안정성이 더 높았습니다. 반대쪽은 특정 구간에서 평가 손실 편차가 커져 흐름을 유지하는 데 어려움이 있었습니다.`)
  if (Math.abs(engineGap) >= 12) lines.push(`엔진 유사도는 ${engineGap > 0 ? '초' : '한'} 쪽이 더 높게 나타납니다. 후보수 선택이 더 자주 평가 보존 방향과 맞았습니다.`)
  const critical = events.find(event => event.severity === 'critical')
  if (critical) lines.push(`전체 승부의 핵심은 ${critical.sideLabel} ${critical.ply}수 전후였습니다. 이 지점에서 주도권과 수비 부담의 균형이 크게 바뀌었습니다.`)
  if (!lines.length) lines.push('양쪽의 성향 차이는 크지 않았고, 승부는 단일한 기풍 차이보다 구체적인 계산 장면의 정확도에서 갈렸습니다.')
  return lines
}

function similarity (metrics) {
  return [
    { key: 'engineLike', label: '엔진형 정밀도 유사성', value: metrics.engineLike, text: koreanScoreLabel(metrics.engineLike, '평가 보존과 전환이 매우 정교합니다', '상위권 실전 감각에 가까운 정확도입니다', '인간적인 기복이 더 크게 드러납니다') },
    { key: 'humanPractical', label: '인간 실전형 유사성', value: metrics.humanPractical, text: koreanScoreLabel(metrics.humanPractical, '보상·압박·복잡성을 적극 활용합니다', '실전성과 안정성의 균형형입니다', '실전적 흔들기보다 정리형에 가깝습니다') },
    { key: 'tactical', label: '전술형 유사성', value: metrics.tacticalDependence, text: koreanScoreLabel(metrics.tacticalDependence, '강제 계산 의존이 높습니다', '필요한 장면에서 전술을 활용합니다', '전술보다 구조 운영 비중이 큽니다') },
    { key: 'positional', label: '포지션형 유사성', value: metrics.positionalPreference, text: koreanScoreLabel(metrics.positionalPreference, '장기 압박과 활동성 관리가 뚜렷합니다', '전술과 포지션의 혼합형입니다', '직접 전술과 변화를 더 선호합니다') },
    { key: 'aggressive', label: '공격 성향 유사성', value: metrics.aggression, text: koreanScoreLabel(metrics.aggression, '주도권을 강하게 밀어붙입니다', '공수 균형을 유지합니다', '안정적 운영을 우선합니다') },
    { key: 'defensive', label: '수비 복원력 유사성', value: metrics.defensiveResilience, text: koreanScoreLabel(metrics.defensiveResilience, '흔들린 뒤에도 빠르게 균형을 회복합니다', '수비 대응이 무난합니다', '압박이 누적될 때 흔들림이 있습니다') }
  ]
}

function buildAnalysis (rawMoves, source) {
  const moves = rawMoves.map((move, idx) => normalizeMove({ ...move, ply: move.ply || idx + 1 }, source))
  if (!moves.length) return null
  const stats = statsForMoves(moves)
  const phases = phaseBreakdown(moves)
  const metrics = analyzerMetrics(moves, stats, phases)
  const events = criticalEvents(moves)
  const sides = buildSideAnalysis(moves, events)
  const isLive = source === 'live'
  const isTemporary = source === 'temporary-review'
  const critical = events.find(event => event.severity === 'critical')
  const instabilityText = critical
    ? `${critical.sideLabel} ${critical.ply}수 전후의 치명적 변동이 해석의 중심입니다. `
    : ''
  return {
    generatedAt: Date.now(),
    source: isLive ? 'live-current-game' : (isTemporary ? 'temporary-review-line' : 'fjace_analyzer_all7.py-inspired bridge'),
    confidence: stats.engineBackedRatio >= 50 ? 'engine-backed' : 'live-heuristic',
    moveCount: moves.length,
    stats,
    phases,
    metrics,
    sides,
    criticalEvents: events,
    comparativeNarratives: comparativeNarratives(sides, events),
    similarity: similarity(metrics),
    narratives: styleNarratives(metrics, phases, moves, isLive, events),
    summary: `${instabilityText}${koreanScoreLabel(metrics.engineLike, '엔진 유사도가 높은', '정교하지만 인간적인', '실전적 편차가 살아 있는')} 흐름입니다. ${koreanScoreLabel(metrics.tacticalDependence, '강제 계산과 전술 압박', '균형 잡힌 후보 선택', '포지션 운영과 장기 압박')}이 두드러지고, 전체 안정성은 ${koreanScoreLabel(metrics.stability, '높은 편', '보통', '다소 흔들리는 편')}입니다.`,
    terms: [
      'ACPL·편차·Top 일치율·구간 분석은 fjace_analyzer_all7.py의 통계 철학을 UI 데이터에 맞게 재해석한 것입니다.',
      '이 리포트는 단정적 판정이 아니라 스타일, 안정성, 국면 전환을 읽기 위한 전략 해설용 참고 자료입니다.',
      '초/한 분리 해석은 같은 기보 안에서도 양쪽의 공격성, 안정성, 수비 복원력이 다르게 나타난다는 전제를 반영합니다.'
    ]
  }
}

export function analyzeGameReview (reviewResult) {
  const sourceMoves = reviewResult && Array.isArray(reviewResult.moves) ? reviewResult.moves : []
  return buildAnalysis(sourceMoves, 'review')
}

export function analyzeReviewSequence (sequence) {
  const sourceMoves = sequence && Array.isArray(sequence.line)
    ? sequence.line.map((move, idx) => ({ move, name: sequence.sans && sequence.sans[idx] ? sequence.sans[idx] : move, ply: idx + 1 }))
    : []
  return buildAnalysis(sourceMoves, 'temporary-review')
}

export function analyzeLiveGame (moves) {
  const sourceMoves = Array.isArray(moves) ? moves.map((move, idx) => ({ ...move, ply: move.ply || idx + 1, move: move.uci || move.name || '' })) : []
  return buildAnalysis(sourceMoves, 'live')
}

export function phaseRingStyle (phases) {
  const fallback = 'conic-gradient(#555 0deg 360deg)'
  if (!Array.isArray(phases) || phases.length < 3) return { background: fallback }
  const alpha = phase => 0.18 + (phase.quality / 100) * 0.82
  return {
    background: `conic-gradient(rgba(114,137,218,${alpha(phases[0])}) 0deg 120deg, rgba(242,153,74,${alpha(phases[1])}) 120deg 240deg, rgba(47,133,90,${alpha(phases[2])}) 240deg 360deg)`
  }
}
