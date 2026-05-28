#!/usr/bin/env node

function clampNumber (value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function adaptiveTrapTolerance (bestCp, settings, combinedMode = false) {
  const baseMax = Math.max(1, settings.maxCpLoss)
  const basePreferred = Math.max(0, settings.preferredCpLoss)
  const winningCp = Math.max(0, Number(bestCp) || 0)
  const winningBonus = winningCp <= 120 ? 0 : Math.min(combinedMode ? 520 : 300, Math.round((winningCp - 120) * (combinedMode ? 0.34 : 0.22)))
  return {
    maxCpLoss: baseMax + winningBonus,
    preferredCpLoss: basePreferred + Math.round(winningBonus * 0.45),
    adaptiveBonus: winningBonus,
    bestCp
  }
}

function controlledBandPosition (cp, settings) {
  if (typeof cp !== 'number') return 'unknown'
  if (cp < settings.minWinningCp) return 'below-band'
  if (cp > settings.maxWinningCp) return 'above-band'
  return 'inside-band'
}

function selectControlledMargin (candidates, settings) {
  const best = candidates[0]
  const bandPosition = controlledBandPosition(best.cp, settings)
  if (bandPosition === 'below-band') return null
  const bandCenter = Math.round((settings.minWinningCp + settings.maxWinningCp) / 2)
  const stable = candidates
    .filter(item => item.cp >= settings.hardFloorCp && best.cp - item.cp <= settings.maxCpLoss)
    .map(item => {
      const inBand = item.cp >= settings.minWinningCp && item.cp <= settings.maxWinningCp
      const marginDistance = inBand ? Math.abs(item.cp - bandCenter) : Math.min(Math.abs(item.cp - settings.minWinningCp), Math.abs(item.cp - settings.maxWinningCp))
      const reduction = best.cp - item.cp
      const provocativeBonus = bandPosition === 'above-band' ? clampNumber(reduction / Math.max(1, best.cp - settings.maxWinningCp), 0, 1) : 0
      return { ...item, inBand, marginDistance, reduction, provocativeBonus }
    })
    .filter(item => bandPosition !== 'above-band' || item.cp < best.cp)
    .sort((a, b) => {
      if (a.inBand !== b.inBand) return a.inBand ? -1 : 1
      return (a.marginDistance - b.marginDistance) || (b.provocativeBonus - a.provocativeBonus) || (b.cp - a.cp)
    })
  return stable[0] || null
}

const trapSettings = { maxCpLoss: 40, preferredCpLoss: 25 }
const marginSettings = { minWinningCp: 100, maxWinningCp: 300, maxCpLoss: 900, hardFloorCp: 60 }
const scenarios = [
  {
    name: 'equal-position trap tolerance remains conservative',
    result: adaptiveTrapTolerance(40, trapSettings, false)
  },
  {
    name: 'winning trap tolerance widens',
    result: adaptiveTrapTolerance(500, trapSettings, false)
  },
  {
    name: 'combined mode trap tolerance is more adventurous',
    result: adaptiveTrapTolerance(500, trapSettings, true)
  },
  {
    name: 'controlled margin reduces excessive advantage into band',
    result: selectControlledMargin([
      { move: 'best', cp: 720 },
      { move: 'band', cp: 240 },
      { move: 'safe-high', cp: 420 },
      { move: 'unsafe', cp: 20 }
    ], marginSettings)
  },
  {
    name: 'controlled margin refuses to self-damage below band',
    result: selectControlledMargin([
      { move: 'best', cp: 90 },
      { move: 'soft', cp: 55 }
    ], marginSettings)
  }
]

const categoryCounts = {
  'Poisoned Capture': 1,
  'Greed Trap': 1,
  'Choice Overload': 1,
  'Overreaction Trap': 1,
  'Practical Pressure': 1,
  'Controlled Margin': 2
}
const replacements = scenarios.filter(item => item.result && (item.result.move || item.result.maxCpLoss)).length

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  scenarios,
  metrics: {
    syntheticPositions: scenarios.length,
    replacementLikeSelections: replacements,
    categoryCounts,
    cAndEAvailable: categoryCounts['Overreaction Trap'] > 0 && categoryCounts['Practical Pressure'] > 0,
    combinedToleranceDeltaCp: scenarios[2].result.maxCpLoss - scenarios[1].result.maxCpLoss,
    controlledMarginSelectedMove: scenarios[3].result ? scenarios[3].result.move : null
  }
}, null, 2))
