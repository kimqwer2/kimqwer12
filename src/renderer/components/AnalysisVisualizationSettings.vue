<template>
  <div class="viz-settings">
    <h4>시각화</h4>
    <label><input v-model="local.showMultiPvArrows" type="checkbox" @change="save"> 후보수 화살표</label>
    <label>표시 후보 수 <input v-model.number="local.multiPvCount" min="1" type="number" @change="save"></label>
    <label><input v-model="local.trajectoryEnabled" type="checkbox" @change="save"> 최선 수순 궤적</label>
    <label>표시 방향
      <select v-model="local.trajectorySideMode" @change="save"><option value="both">양쪽</option><option value="my">내 수</option></select>
    </label>
    <label>궤적 깊이
      <select v-model="depthMode" @change="saveDepth"><option value="4">4</option><option value="8">8</option><option value="12">12</option><option value="20">20</option><option value="40">40</option><option value="unlimited">무제한</option></select>
    </label>
    <label>표시 방식
      <select v-model="local.visualizationMode" @change="save"><option value="arrow">화살표</option><option value="ghost">잔상 궤적</option><option value="hybrid">혼합</option></select>
    </label>
    <label><input v-model="local.orderNumbers" type="checkbox" @change="save"> 순번 표시</label>
    <label><input v-model="local.orderThickness" type="checkbox" @change="save"> 두께 반영</label>
    <label><input v-model="local.orderOpacity" type="checkbox" @change="save"> 투명도 반영</label>
    <label>일반 분석 목표 깊이
      <select v-model="targetDepth" @change="saveTarget"><option value="infinite">무제한</option><option value="10">10</option><option value="15">15</option><option value="20">20</option><option value="25">25</option></select>
    </label>

    <details class="deep-advanced">
      <summary>수순 리뷰 깊이</summary>
      <label>프리셋
        <select v-model="local.reviewDepthPreset" @change="applyReviewPreset">
          <option value="fast">빠르게</option>
          <option value="normal">보통</option>
          <option value="deep">깊게</option>
          <option value="expert">전문가</option>
        </select>
      </label>
      <label>리뷰 깊이 <input v-model.number="local.reviewDepth" min="6" max="32" type="number" @change="save"></label>
      <label>전술 확인 깊이 <input v-model.number="local.reviewTacticalDepth" min="4" max="32" type="number" @change="save"></label>
      <label>전략 수순 범위 <input v-model.number="local.reviewStrategicHorizon" min="1" max="60" type="number" @change="save"></label>
      <label>응징 수순 길이 <input v-model.number="local.reviewPunishmentLineLength" min="2" max="12" type="number" @change="save"></label>
      <label>해설 밀도
        <select v-model="local.reviewDetailLevel" @change="save">
          <option value="compact">간결</option>
          <option value="balanced">균형</option>
          <option value="verbose">상세</option>
        </select>
      </label>
      <label><input v-model="local.realtimeGameCommentary" type="checkbox" @change="save"> 실시간 전략 해설</label>
      <label><input v-model="local.realtimeCommentaryArrows" type="checkbox" @change="save"> 실시간 전략 화살표 표시</label>
      <small>켜면 임시 수순이나 현재 기보 흐름이 잠시 멈춘 뒤 자동으로 엔진 리뷰를 반영합니다. 화살표 옵션은 실시간 전략 해설이 만든 표시만 조절하며 일반 엔진/수순 리뷰 표시는 유지됩니다.</small>
      <small>깊게/전문가 모드는 느리지만 지연 전술, 장기 압박, 응징 수순을 더 오래 추적합니다.</small>
    </details>

    <div class="deep-box">
      <h4>분석 모드</h4>
      <label class="radio-row"><input v-model="local.analysisModeType" type="radio" value="normal" @change="save"> 일반 분석</label>
      <label class="radio-row"><input v-model="local.analysisModeType" type="radio" value="deep" @change="save"> 심층 분석</label>
      <small>심층 분석은 후보수를 먼저 넓게 확보한 뒤, 각 후보를 독립된 수순처럼 다시 검토해 편향과 불안정성을 줄이는 감독 모드입니다.</small>

      <template v-if="local.analysisModeType === 'deep'">
        <button type="button" :disabled="deepAnalysis.running" @click="startDeepAnalysis">
          {{ deepAnalysis.running ? '심층 분석 진행 중…' : '심층 분석 실행' }}
        </button>
        <details class="deep-advanced">
          <summary>심층 분석 세부 설정</summary>
          <label>후보수 개수 <input v-model.number="local.deepCandidateCount" min="1" max="8" type="number" @change="save"></label>
          <label>초기 후보 탐색(초) <input :value="msToSec(local.deepRootTimeMs)" min="1" type="number" @change="saveMs('deepRootTimeMs', $event.target.value)"></label>
          <label>후보별 분석 시간(초) <input :value="msToSec(local.deepTimePerCandidateMs)" min="1" type="number" @change="saveMs('deepTimePerCandidateMs', $event.target.value)"></label>
          <label>보조 후보 분석(초) <input :value="msToSec(local.deepSecondaryTimeMs)" min="1" type="number" @change="saveMs('deepSecondaryTimeMs', $event.target.value)"></label>
          <label>후보별 깊이 <input v-model.number="local.deepDepthPerCandidate" min="0" type="number" @change="save"></label>
          <label>시간 배분
            <select v-model="local.deepScheduleMode" @change="save">
              <option value="equal">동일 시간</option>
              <option value="top-short-secondary-long">1순위 짧게 / 대안 길게</option>
              <option value="dynamic-instability">불안정도 기반 동적 배분</option>
            </select>
          </label>
          <label><input v-model="local.deepClearHashBetweenCandidates" type="checkbox" @change="save"> 후보 사이 해시 초기화</label>
          <label>불안정 민감도(cp) <input v-model.number="local.deepInstabilitySensitivityCp" min="20" type="number" @change="save"></label>
          <label>다양성 기준 <input v-model.number="local.deepDiversityThreshold" min="1" type="number" @change="save"></label>
          <label>후보 최대 시간(초) <input :value="msToSec(local.deepMaxDurationMs)" min="5" type="number" @change="saveMs('deepMaxDurationMs', $event.target.value)"></label>
        </details>
      </template>
    </div>

    <div v-if="deepAnalysis.error" class="deep-error">
      {{ deepAnalysis.error }}
    </div>

    <div v-if="deepAnalysis.report" class="deep-report">
      <div class="report-heading">
        <strong>심층 분석 리포트</strong>
        <button type="button" @click="clearDeepAnalysis">지우기</button>
      </div>
      <small>
        {{ deepAnalysis.report.summary.candidateCount }} 개 후보 ·
        {{ deepAnalysis.report.summary.volatileCount }} 개 불안정 ·
        {{ formatMs(deepAnalysis.report.elapsedMs) }} 소요
      </small>
      <div
        v-for="candidate in deepAnalysis.report.candidates"
        :key="candidate.move"
        :class="['candidate-card', volatilityClass(candidate.stability)]"
      >
        <div class="candidate-title">
          <strong>#{{ candidate.finalRank }} {{ candidate.move }}</strong>
          <span>{{ stabilityText(candidate.stability) }}</span>
        </div>
        <small>{{ diversityText(candidate.diversityTag) }}</small>
        <div class="candidate-grid">
          <span>최종 {{ scoreText(candidate.finalScore) }}</span>
          <span>최고 {{ cpText(candidate.maxScore) }}</span>
          <span>흔들림 {{ cpText(candidate.evalDrift) }}</span>
          <span>깊이 {{ candidate.depthReached || '-' }}</span>
          <span>시간 {{ formatMs(candidate.timeMs) }}</span>
          <span>PV 변화 {{ candidate.pvChanges }}</span>
          <span>최선수 교체 {{ candidate.bestMoveSwitches }}</span>
          <span>순위 변화 {{ rankChange(candidate.rankingChange) }}</span>
        </div>
        <small v-if="candidate.final && candidate.final.pvUCI">PV {{ candidate.final.pvUCI }}</small>
        <div class="flags">
          <span v-if="candidate.flags && candidate.flags.highDisagreement">평가 불일치 큼</span>
          <span v-if="candidate.flags && candidate.flags.lateImprovement">후반 개선</span>
          <span v-if="candidate.flags && candidate.flags.collapsedCandidate">후보 붕괴</span>
          <span v-if="candidate.flags && candidate.flags.dynamicallyExtended">동적 연장</span>
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
    applyReviewPreset () {
      const presets = {
        fast: { reviewDepth: 8, reviewTacticalDepth: 6, reviewStrategicHorizon: 8, reviewPunishmentLineLength: 4, reviewDetailLevel: 'compact' },
        normal: { reviewDepth: 10, reviewTacticalDepth: 8, reviewStrategicHorizon: 20, reviewPunishmentLineLength: 6, reviewDetailLevel: 'balanced' },
        deep: { reviewDepth: 16, reviewTacticalDepth: 14, reviewStrategicHorizon: 36, reviewPunishmentLineLength: 8, reviewDetailLevel: 'verbose' },
        expert: { reviewDepth: 22, reviewTacticalDepth: 20, reviewStrategicHorizon: 60, reviewPunishmentLineLength: 12, reviewDetailLevel: 'verbose' }
      }
      this.local = { ...this.local, ...(presets[this.local.reviewDepthPreset] || presets.normal) }
      this.save()
    },
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
    stabilityText (value) {
      if (value === 'highly volatile') return '매우 불안정'
      if (value === 'unstable') return '불안정'
      return '안정적'
    },
    diversityText (value) {
      const labels = {
        'forcing / tactical': '강제 전술 후보',
        'advantage conversion': '우세 전환 후보',
        'defensive resource': '수비 자원 후보',
        'alternative plan': '대안 계획 후보',
        'principal plan': '주요 계획 후보',
        'engine bestmove fallback': '엔진 최선수 보조 후보',
        'engine candidate': '엔진 후보수'
      }
      return labels[value] || value || '후보수'
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
.deep-report { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--main-border-color); }
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
