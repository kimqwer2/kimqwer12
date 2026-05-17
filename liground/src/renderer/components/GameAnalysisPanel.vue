<template>
  <section class="game-analysis panel">
    <div class="analysis-title">
      <div>
        <h3>Game Analysis</h3>
        <p>엔진 리뷰 위에 올리는 고급 전략·스타일 메타 리포트입니다.</p>
      </div>
      <button type="button" :disabled="!canAnalyze" @click="refreshAnalysis">분석 갱신</button>
    </div>

    <div v-if="!canAnalyze" class="analysis-empty">
      먼저 수순 리뷰나 선택 수 검토를 실행하면, 해당 엔진 리뷰 결과를 바탕으로 플레이 스타일과 구간별 품질을 해석합니다.
    </div>

    <template v-else-if="analysis">
      <p class="summary">{{ analysis.summary }}</p>

      <div class="phase-visual">
        <div class="phase-ring" :style="ringStyle">
          <span>Phase</span>
        </div>
        <div class="phase-list">
          <div v-for="phase in analysis.phases" :key="phase.key" class="phase-row">
            <span class="phase-dot" :style="{ backgroundColor: phase.color }" />
            <strong>{{ phase.label }}</strong>
            <span>{{ qualityText(phase.quality) }}</span>
            <small>{{ acplText(phase.acpl) }} · {{ phase.count }}수</small>
          </div>
        </div>
      </div>

      <details open class="meta-section">
        <summary>Strategic profile</summary>
        <div class="metric-grid">
          <div v-for="metric in primaryMetrics" :key="metric.key" class="metric-card">
            <span>{{ metric.label }}</span>
            <strong>{{ Math.round(metric.value) }}</strong>
            <div class="meter"><i :style="{ width: `${Math.round(metric.value)}%` }" /></div>
          </div>
        </div>
      </details>

      <details open class="meta-section">
        <summary>AI / Style similarity</summary>
        <div class="similarity-list">
          <div v-for="item in analysis.similarity" :key="item.key" class="similarity-row">
            <div>
              <strong>{{ item.label }}</strong>
              <small>{{ item.text }}</small>
            </div>
            <span>{{ Math.round(item.value) }}%</span>
          </div>
        </div>
      </details>

      <details class="meta-section">
        <summary>Interpretation notes</summary>
        <ul>
          <li v-for="line in analysis.narratives" :key="line">{{ line }}</li>
        </ul>
        <div class="stats-row">
          <span>ACPL {{ analysis.stats.acpl.toFixed(1) }}</span>
          <span>Top-1 {{ analysis.stats.top1.toFixed(1) }}%</span>
          <span>편차 {{ analysis.stats.stdDev.toFixed(1) }}</span>
          <span>Blunder {{ analysis.stats.blunder }}</span>
        </div>
        <small v-for="term in analysis.terms" :key="term" class="term">{{ term }}</small>
      </details>
    </template>
  </section>
</template>

<script>
import { analyzeGameReview, phaseRingStyle } from '../../shared/review/gameAnalysis'

export default {
  name: 'GameAnalysisPanel',
  data () {
    return {
      localAnalysis: null
    }
  },
  computed: {
    reviewResult () {
      return this.$store.getters.reviewResult
    },
    canAnalyze () {
      return Boolean(this.reviewResult && Array.isArray(this.reviewResult.moves) && this.reviewResult.moves.length)
    },
    analysis () {
      return this.localAnalysis || (this.canAnalyze ? analyzeGameReview(this.reviewResult) : null)
    },
    ringStyle () {
      return this.analysis ? phaseRingStyle(this.analysis.phases) : {}
    },
    primaryMetrics () {
      if (!this.analysis) return []
      const m = this.analysis.metrics
      return [
        { key: 'tacticalDependence', label: 'Tactical dependence', value: m.tacticalDependence },
        { key: 'positionalPreference', label: 'Positional preference', value: m.positionalPreference },
        { key: 'aggression', label: 'Aggression', value: m.aggression },
        { key: 'stability', label: 'Stability', value: m.stability },
        { key: 'practicality', label: 'Practicality', value: m.practicality },
        { key: 'riskProfile', label: 'Risk profile', value: m.riskProfile },
        { key: 'strategicSharpness', label: 'Strategic sharpness', value: m.strategicSharpness },
        { key: 'conversionQuality', label: 'Conversion quality', value: m.conversionQuality },
        { key: 'defensiveResilience', label: 'Defensive resilience', value: m.defensiveResilience }
      ]
    }
  },
  watch: {
    reviewResult () {
      this.localAnalysis = null
    }
  },
  methods: {
    refreshAnalysis () {
      this.localAnalysis = analyzeGameReview(this.reviewResult)
    },
    acplText (value) {
      return typeof value === 'number' ? `ACPL ${value.toFixed(1)}` : '데이터 부족'
    },
    qualityText (value) {
      if (value >= 75) return '강점 구간'
      if (value >= 45) return '보통 구간'
      return '불안정 구간'
    }
  }
}
</script>

<style scoped>
.game-analysis {
  margin: 10px 0;
  padding: 10px;
  background: var(--second-bg-color);
  border: 1px solid var(--main-border-color);
  border-radius: 6px;
  color: var(--main-text-color);
  text-align: left;
  font-size: 12px;
}
.analysis-title,
.phase-visual,
.similarity-row,
.stats-row {
  display: flex;
  gap: 10px;
}
.analysis-title {
  justify-content: space-between;
  align-items: flex-start;
}
h3, p { margin: 0; }
.analysis-title p,
.analysis-empty,
.term,
small { color: var(--second-text-color, #9aa0a6); }
button {
  border: none;
  border-radius: 4px;
  padding: 6px 8px;
  background: #7289da;
  color: white;
  cursor: pointer;
}
button:disabled { opacity: 0.55; cursor: default; }
.summary {
  margin-top: 8px;
  padding: 8px;
  border-radius: 5px;
  background: rgba(114, 137, 218, 0.12);
}
.phase-visual {
  align-items: center;
  margin-top: 10px;
}
.phase-ring {
  width: 112px;
  height: 112px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: 50%;
  box-shadow: inset 0 0 0 16px rgba(0, 0, 0, 0.22);
  font-weight: 800;
}
.phase-list {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
}
.phase-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 6px;
  align-items: center;
}
.phase-row small { grid-column: 2 / 4; }
.phase-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.meta-section {
  margin-top: 10px;
  padding: 8px;
  border-radius: 5px;
  background: rgba(127, 127, 127, 0.08);
}
.meta-section summary { cursor: pointer; font-weight: 800; }
.metric-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(135px, 1fr));
  gap: 7px;
  margin-top: 8px;
}
.metric-card {
  padding: 7px;
  border-radius: 5px;
  background: rgba(127, 127, 127, 0.12);
}
.metric-card strong {
  float: right;
}
.meter {
  clear: both;
  height: 6px;
  margin-top: 7px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.22);
  overflow: hidden;
}
.meter i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #7289da, #f2994a);
}
.similarity-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.similarity-row {
  justify-content: space-between;
  padding: 7px;
  border-radius: 5px;
  background: rgba(127, 127, 127, 0.12);
}
.similarity-row div {
  display: flex;
  flex-direction: column;
}
.similarity-row span {
  font-weight: 900;
}
ul { margin: 8px 0 0 16px; padding: 0; }
.stats-row {
  flex-wrap: wrap;
  margin-top: 8px;
}
.stats-row span {
  padding: 3px 6px;
  border-radius: 999px;
  background: rgba(114, 137, 218, 0.18);
}
.term {
  display: block;
  margin-top: 6px;
}
@media (max-width: 780px) {
  .phase-visual { align-items: flex-start; }
  .phase-ring { width: 88px; height: 88px; }
}
</style>
