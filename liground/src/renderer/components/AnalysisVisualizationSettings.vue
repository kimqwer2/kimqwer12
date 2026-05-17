<template>
  <div class="viz-settings">
    <h4>Visualization</h4>
    <label><input v-model="local.showMultiPvArrows" type="checkbox" @change="save"> MultiPV arrows</label>
    <label>Top N <input v-model.number="local.multiPvCount" min="1" type="number" @change="save"></label>
    <label><input v-model="local.trajectoryEnabled" type="checkbox" @change="save"> Best-line trajectory</label>
    <label>Side
      <select v-model="local.trajectorySideMode" @change="save"><option value="both">Both</option><option value="my">My side</option></select>
    </label>
    <label>Depth
      <select v-model="depthMode" @change="saveDepth"><option value="4">4</option><option value="8">8</option><option value="12">12</option><option value="20">20</option><option value="40">40</option><option value="unlimited">Unlimited</option></select>
    </label>
    <label>Render mode
      <select v-model="local.visualizationMode" @change="save"><option value="arrow">Arrow</option><option value="ghost">Ghost trajectory</option><option value="hybrid">Hybrid</option></select>
    </label>
    <label><input v-model="local.orderNumbers" type="checkbox" @change="save"> Number badges</label>
    <label><input v-model="local.orderThickness" type="checkbox" @change="save"> Thickness</label>
    <label><input v-model="local.orderOpacity" type="checkbox" @change="save"> Opacity</label>
    <label>Target analysis depth
      <select v-model="targetDepth" @change="saveTarget"><option value="infinite">Infinite</option><option value="10">10</option><option value="15">15</option><option value="20">20</option><option value="25">25</option></select>
    </label>

    <div class="deep-box">
      <h4>Analysis Mode</h4>
      <label class="radio-row"><input v-model="local.analysisModeType" type="radio" value="normal" @change="save"> Normal</label>
      <label class="radio-row"><input v-model="local.analysisModeType" type="radio" value="deep" @change="save"> Deep Analysis</label>
      <small>Deep Analysis is an analysis supervisor: it gets MultiPV candidates, then re-analyzes each candidate as an isolated worldline.</small>

      <template v-if="local.analysisModeType === 'deep'">
        <button type="button" :disabled="deepAnalysis.running" @click="startDeepAnalysis">
          {{ deepAnalysis.running ? 'Deep analysis running…' : 'Run Deep Analysis' }}
        </button>
        <details class="deep-advanced">
          <summary>Deep Analysis Settings</summary>
          <label>Candidate count <input v-model.number="local.deepCandidateCount" min="1" max="8" type="number" @change="save"></label>
          <label>Root MultiPV time (sec) <input :value="msToSec(local.deepRootTimeMs)" min="1" type="number" @change="saveMs('deepRootTimeMs', $event.target.value)"></label>
          <label>Time per candidate (sec) <input :value="msToSec(local.deepTimePerCandidateMs)" min="1" type="number" @change="saveMs('deepTimePerCandidateMs', $event.target.value)"></label>
          <label>Secondary time (sec) <input :value="msToSec(local.deepSecondaryTimeMs)" min="1" type="number" @change="saveMs('deepSecondaryTimeMs', $event.target.value)"></label>
          <label>Depth per candidate <input v-model.number="local.deepDepthPerCandidate" min="0" type="number" @change="save"></label>
          <label>Schedule
            <select v-model="local.deepScheduleMode" @change="save">
              <option value="equal">Equal time</option>
              <option value="top-short-secondary-long">Top short / secondary long</option>
              <option value="dynamic-instability">Dynamic by instability</option>
            </select>
          </label>
          <label><input v-model="local.deepClearHashBetweenCandidates" type="checkbox" @change="save"> Clear hash between candidates</label>
          <label>Instability sensitivity (cp) <input v-model.number="local.deepInstabilitySensitivityCp" min="20" type="number" @change="save"></label>
          <label>Diversity threshold <input v-model.number="local.deepDiversityThreshold" min="1" type="number" @change="save"></label>
          <label>Max candidate duration (sec) <input :value="msToSec(local.deepMaxDurationMs)" min="5" type="number" @change="saveMs('deepMaxDurationMs', $event.target.value)"></label>
        </details>
      </template>
    </div>

    <div v-if="deepAnalysis.error" class="deep-error">
      {{ deepAnalysis.error }}
    </div>

    <div v-if="deepAnalysis.report" class="deep-report">
      <div class="report-heading">
        <strong>Deep Analysis Report</strong>
        <button type="button" @click="clearDeepAnalysis">Clear</button>
      </div>
      <small>
        {{ deepAnalysis.report.summary.candidateCount }} candidates ·
        {{ deepAnalysis.report.summary.volatileCount }} unstable ·
        {{ formatMs(deepAnalysis.report.elapsedMs) }} total
      </small>
      <div
        v-for="candidate in deepAnalysis.report.candidates"
        :key="candidate.move"
        :class="['candidate-card', volatilityClass(candidate.stability)]"
      >
        <div class="candidate-title">
          <strong>#{{ candidate.finalRank }} {{ candidate.move }}</strong>
          <span>{{ candidate.stability }}</span>
        </div>
        <small>{{ candidate.diversityTag }}</small>
        <div class="candidate-grid">
          <span>Final {{ scoreText(candidate.finalScore) }}</span>
          <span>Max {{ cpText(candidate.maxScore) }}</span>
          <span>Drift {{ cpText(candidate.evalDrift) }}</span>
          <span>Depth {{ candidate.depthReached || '-' }}</span>
          <span>Time {{ formatMs(candidate.timeMs) }}</span>
          <span>PV changes {{ candidate.pvChanges }}</span>
          <span>Best switches {{ candidate.bestMoveSwitches }}</span>
          <span>Rank Δ {{ rankChange(candidate.rankingChange) }}</span>
        </div>
        <small v-if="candidate.final && candidate.final.pvUCI">PV {{ candidate.final.pvUCI }}</small>
        <div class="flags">
          <span v-if="candidate.flags && candidate.flags.highDisagreement">high disagreement</span>
          <span v-if="candidate.flags && candidate.flags.lateImprovement">late improvement</span>
          <span v-if="candidate.flags && candidate.flags.collapsedCandidate">collapsed candidate</span>
          <span v-if="candidate.flags && candidate.flags.dynamicallyExtended">dynamically extended</span>
        </div>
      </div>
    </div>
  </div>
</template>
<script>
export default {
  name: 'AnalysisVisualizationSettings',
  data: () => ({ local: {}, depthMode: '12', targetDepth: 'infinite' }),
  computed: {
    cfg () { return this.$store.getters.analysisVisualization },
    deepAnalysis () { return this.$store.getters.deepAnalysis }
  },
  watch: {
    cfg: {
      deep: true,
      immediate: true,
      handler () {
        this.local = { ...this.cfg }
        this.depthMode = this.cfg.trajectoryUnlimited ? 'unlimited' : String(this.cfg.trajectoryDepth)
        this.targetDepth = this.cfg.analysisTargetDepth || 'infinite'
      }
    }
  },
  methods: {
    save () {
      this.$store.dispatch('analysisVisualization', this.local)
      if (typeof this.local.multiPvCount === 'number' && this.local.multiPvCount > 0) {
        this.$store.dispatch('setEngineOptions', { MultiPV: this.local.multiPvCount })
      }
    },
    saveDepth () { this.local.trajectoryUnlimited = this.depthMode === 'unlimited'; if (!this.local.trajectoryUnlimited) this.local.trajectoryDepth = Number(this.depthMode); this.save() },
    saveTarget () { this.$store.dispatch('analysisVisualization', { analysisTargetDepth: this.targetDepth }) },
    saveMs (key, seconds) {
      const value = Math.max(1, Number(seconds) || 1) * 1000
      this.local[key] = value
      this.save()
    },
    startDeepAnalysis () {
      this.save()
      this.$store.dispatch('startDeepAnalysis')
    },
    clearDeepAnalysis () {
      this.$store.dispatch('clearDeepAnalysis')
    },
    msToSec (value) {
      return Math.round((Number(value) || 0) / 1000)
    },
    formatMs (value) {
      if (!value) return '0s'
      const seconds = Math.round(value / 1000)
      if (seconds < 60) return `${seconds}s`
      return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    },
    cpText (value) {
      if (typeof value !== 'number') return '-'
      return `${value >= 0 ? '+' : ''}${Math.round(value)}cp`
    },
    scoreText (score) {
      if (!score) return '-'
      if (typeof score.mate === 'number') return `M${score.mate}`
      return this.cpText(score.normalized)
    },
    rankChange (value) {
      if (!value) return '0'
      return value > 0 ? `+${value}` : String(value)
    },
    volatilityClass (value) {
      if (value === 'highly volatile') return 'volatile-high'
      if (value === 'unstable') return 'volatile-medium'
      return 'volatile-stable'
    }
  }
}
</script>
<style scoped>
.viz-settings { margin: 8px 0; padding: 8px; background: var(--second-bg-color); border-radius: 6px; font-size: 12px; color: var(--main-text-color); display:flex; flex-direction:column; gap:6px; }
label { display:flex; justify-content:space-between; gap:8px; align-items:center; }
input[type="number"], select { max-width: 130px; background: var(--main-bg-color); color: var(--main-text-color); border: 1px solid var(--main-border-color); border-radius: 3px; }
h4 { margin: 0 0 4px 0; }
button { border: none; border-radius: 4px; padding: 6px 8px; background: #7289da; color: white; cursor: pointer; }
button:disabled { cursor: default; opacity: 0.6; }
small { color: var(--second-text-color, #9aa0a6); overflow-wrap: anywhere; }
.deep-box { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--main-border-color); }
.radio-row { justify-content: flex-start; }
.deep-error { padding: 6px; border-left: 4px solid #d7263d; background: rgba(215, 38, 61, 0.18); }
.deep-report { display: flex; flex-direction: column; gap: 6px; max-height: 45vh; overflow-y: auto; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--main-border-color); overscroll-behavior: contain; }
.deep-advanced { display: flex; flex-direction: column; gap: 6px; padding: 6px; border-radius: 4px; background: rgba(127,127,127,0.08); }
.deep-advanced[open] { display: flex; }
.deep-advanced summary { cursor: pointer; font-weight: 700; }
.deep-advanced label { margin-top: 6px; }
.report-heading, .candidate-title { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
.report-heading button { background: #555; }
.candidate-card { padding: 7px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.16); background: rgba(127,127,127,0.10); }
.candidate-title span { padding: 2px 6px; border-radius: 999px; font-size: 10px; background: rgba(127,127,127,0.25); }
.candidate-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 8px; margin: 5px 0; }
.flags { display: flex; flex-wrap: wrap; gap: 4px; }
.flags span { padding: 2px 5px; border-radius: 999px; background: rgba(242,153,74,0.25); color: #ffd08a; }
.volatile-stable { border-left: 4px solid #2f855a; }
.volatile-medium { border-left: 4px solid #f2994a; }
.volatile-high { border-left: 4px solid #d7263d; }
</style>
