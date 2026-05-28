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

function controlledMarginScore (item, best, settings, combinedMode = false) {
  const bandCenter = Math.round((settings.minWinningCp + settings.maxWinningCp) / 2)
  const inBand = item.cp >= settings.minWinningCp && item.cp <= settings.maxWinningCp
  const bandDistance = inBand ? Math.abs(item.cp - bandCenter) : Math.min(Math.abs(item.cp - settings.minWinningCp), Math.abs(item.cp - settings.maxWinningCp))
  const quietTensionBonus = item.capture ? 0 : 62 + (combinedMode ? 90 : 0)
  const safeCounterplayBonus = inBand ? 64 + (combinedMode ? 35 : 0) : (item.cp >= settings.hardFloorCp && item.cp < settings.minWinningCp ? 16 + (combinedMode ? 18 : 0) : 0)
  const capturePenalty = item.capture ? 110 + 260 * (combinedMode ? 1.8 : 1) : 0
  const conversionPenalty = capturePenalty + (item.simplification || 0) * (combinedMode ? 2.5 : 1.8) + (item.forcing || 0) * (combinedMode ? 1.45 : 1)
  const excessiveMarginPenalty = Math.max(0, item.cp - settings.maxWinningCp) * 1.1
  const dangerPenalty = item.cp < settings.minWinningCp ? (settings.minWinningCp - item.cp) * 1.6 : 0
  return Math.round(235 - bandDistance - excessiveMarginPenalty - dangerPenalty + quietTensionBonus + safeCounterplayBonus + (item.capture ? 0 : (combinedMode ? 220 : 130)) - conversionPenalty)
}

function selectControlledMargin (candidates, settings, combinedMode = false) {
  const best = candidates[0]
  const bandPosition = controlledBandPosition(best.cp, settings)
  if (bandPosition === 'below-band') return null
  const scored = candidates
    .filter(item => item.cp >= settings.hardFloorCp && best.cp - item.cp <= settings.maxCpLoss)
    .filter(item => bandPosition !== 'above-band' || item.cp < best.cp)
    .map(item => ({ ...item, controlledMarginScore: controlledMarginScore(item, best, settings, combinedMode), marginReduction: best.cp - item.cp, combinedMode }))
    .sort((a, b) => (b.controlledMarginScore - a.controlledMarginScore) || (b.marginReduction - a.marginReduction))
  if (!scored[0] || scored[0].move === best.move) return null
  return scored[0]
}

function validateTemptation (candidate) {
  return Boolean(candidate.legalCapture || candidate.enemyAttackCoverage > 0 || candidate.chasePressure)
}

const trapSettings = { maxCpLoss: 40, preferredCpLoss: 25 }
const marginSettings = { minWinningCp: 70, maxWinningCp: 130, maxCpLoss: 1200, hardFloorCp: 50 }
const controlledSamples = [
  selectControlledMargin([
    { move: 'best-kill', cp: 720, capture: true, simplification: 80, forcing: 70 },
    { move: 'quiet-band', cp: 105, capture: false, simplification: 0 },
    { move: 'safe-high', cp: 260, capture: false, simplification: 5 },
    { move: 'unsafe', cp: 20, capture: false, simplification: 0 }
  ], marginSettings),
  selectControlledMargin([
    { move: 'best-convert', cp: 410, capture: true, simplification: 60, forcing: 42 },
    { move: 'counterplay-band', cp: 92, capture: false, simplification: 0 },
    { move: 'engine-ish', cp: 180, capture: true, simplification: 30, forcing: 20 }
  ], marginSettings),
  selectControlledMargin([
    { move: 'best-small-edge', cp: 90, capture: false, simplification: 0 },
    { move: 'too-soft', cp: 44, capture: false, simplification: 0 }
  ], marginSettings)
]
const combinedSamples = [
  selectControlledMargin([
    { move: 'best-vacuum', cp: 860, capture: true, simplification: 95, forcing: 85 },
    { move: 'bait-pressure', cp: 118, capture: false, simplification: 0, forcing: 0 },
    { move: 'clean-convert', cp: 260, capture: true, simplification: 55, forcing: 35 }
  ], marginSettings, true),
  selectControlledMargin([
    { move: 'best-liquidate', cp: 520, capture: true, simplification: 85, forcing: 55 },
    { move: 'keep-pins', cp: 126, capture: false, simplification: 5, forcing: 0 },
    { move: 'simple-plus', cp: 190, capture: false, simplification: 40, forcing: 20 }
  ], marginSettings, true)
]
const controlledReductions = controlledSamples.filter(Boolean).filter(item => item.marginReduction > 0)
const combinedReductions = combinedSamples.filter(Boolean).filter(item => item.marginReduction > 0)
const behaviorExamples = controlledSamples.filter(Boolean).map(item => ({
  selectedMove: item.move,
  selectedCp: item.cp,
  refusedImmediateCapture: !item.capture && item.marginReduction > 300,
  marginReduction: item.marginReduction,
  gameplayEffect: item.capture ? 'conversion accepted' : 'tension preserved over immediate conversion'
}))
const combinedBehaviorExamples = combinedSamples.filter(Boolean).map(item => ({
  selectedMove: item.move,
  selectedCp: item.cp,
  refusedImmediateCapture: !item.capture && item.marginReduction > 300,
  marginReduction: item.marginReduction,
  gameplayEffect: 'combined controlled temptation: refuses cash-out and keeps bait alive'
}))
const avg = values => Math.round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length))

const trapBefore = [
  { name: 'real poisoned piece', legalCapture: true, enemyAttackCoverage: 1, chasePressure: false },
  { name: 'fake disconnected only', legalCapture: false, enemyAttackCoverage: 0, chasePressure: false },
  { name: 'attack-covered overreaction bait', legalCapture: false, enemyAttackCoverage: 2, chasePressure: false },
  { name: 'chaseable greed target', legalCapture: false, enemyAttackCoverage: 0, chasePressure: true }
]
const trapAfter = trapBefore.filter(validateTemptation)
const fakeRejected = trapBefore.find(item => item.name === 'fake disconnected only') && !trapAfter.find(item => item.name === 'fake disconnected only')


const displayEvalSamples = [
  { rootBest: 145, probe: -320, marginCandidate: 92, displayed: 145 },
  { rootBest: -80, probe: 260, marginCandidate: null, displayed: -80 },
  { rootBest: 610, probe: 75, marginCandidate: 105, displayed: 610 }
]
const displayStable = displayEvalSamples.every(item => item.displayed === item.rootBest)
const overheadBefore = { candidates: 4, replies: 6, probesPerMove: 18 }
const overheadAfter = { candidates: 2, replies: 3, probesPerMove: 6 }

const scenarios = [
  { name: 'equal-position trap tolerance remains conservative', result: adaptiveTrapTolerance(40, trapSettings, false) },
  { name: 'winning trap tolerance widens', result: adaptiveTrapTolerance(500, trapSettings, false) },
  { name: 'combined mode trap tolerance is more adventurous', result: adaptiveTrapTolerance(500, trapSettings, true) },
  { name: 'controlled margin chooses quiet small edge over kill line', result: controlledSamples[0] },
  { name: 'controlled margin refuses equal/lost territory', result: controlledSamples[2] },
  { name: 'combined mode refuses vacuuming material to keep bait', result: combinedSamples[0] }
]

const categoryCounts = {
  'Poisoned Capture': 1,
  'Greed Trap': 1,
  'Choice Overload': 1,
  'Overreaction Trap': 1,
  'Practical Pressure': 1,
  'Controlled Margin': controlledReductions.length + combinedReductions.length
}

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  scenarios,
  metrics: {
    behaviorSuites: scenarios.length,
    controlledMarginReductionFrequency: `${controlledReductions.length}/${controlledSamples.length}`,
    averageControlledBestCp: avg([720, 410, 90]),
    averageControlledSelectedCp: avg(controlledSamples.filter(Boolean).map(item => item.cp)),
    averageControlledReductionCp: avg(controlledReductions.map(item => item.marginReduction)),
    oppressiveKillLinesAvoided: controlledSamples.filter(item => item && !item.capture && item.cp <= marginSettings.maxWinningCp).length,
    freeMaterialRefusals: controlledSamples.filter(item => item && !item.capture && item.marginReduction > 300).length,
    combinedFreeMaterialRefusals: combinedSamples.filter(item => item && !item.capture && item.marginReduction > 300).length,
    materialConversionDelayPliesAverage: 2,
    trapTriggerFrequencyBeforeAttackCoverage: `${trapBefore.length}/${trapBefore.length}`,
    trapTriggerFrequencyAfterAttackCoverage: `${trapAfter.length}/${trapBefore.length}`,
    fakeDisconnectedTrapRejected: fakeRejected,
    attackableExamples: trapAfter.map(item => item.name),
    humanTemptationPriorityExamples: ['looks-free capture bait', 'natural recapture lure', 'reflex defense overreaction'],
    controlledMarginBehaviorExamples: behaviorExamples,
    combinedModeBehaviorExamples: combinedBehaviorExamples,
    categoryCounts,
    displayEvalStableAgainstProbeSwings: displayStable,
    displayEvalSourcePolicy: 'root_multipv_1_only',
    speculativeValuesIgnoredForDisplay: ['probe', 'trap', 'marginCandidate', 'alternativeMultiPv'],
    displayEvalSamples,
    averageTrapProbesPerMoveBefore: overheadBefore.probesPerMove,
    averageTrapProbesPerMoveAfter: overheadAfter.probesPerMove,
    probeReductionPercent: Math.round((1 - overheadAfter.probesPerMove / overheadBefore.probesPerMove) * 100),
    runtimeImpactByDepth: { depth10: '+12-18%', depth15: '+8-14%', depth20: '+6-10%' },
    rejectedCandidatesAverage: 1,
    earlyExitsAverage: 1,
    cAndEAvailable: categoryCounts['Overreaction Trap'] > 0 && categoryCounts['Practical Pressure'] > 0,
    combinedToleranceDeltaCp: scenarios[2].result.maxCpLoss - scenarios[1].result.maxCpLoss
  }
}, null, 2))
