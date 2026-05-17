<template>
  <section class="game-analysis panel">
    <div class="analysis-title">
      <div>
        <h3>기보 메타 분석</h3>
        <p>엔진 리뷰와 현재 수순 흐름 위에 올리는 전략·성향 해설입니다.</p>
      </div>
      <button type="button" :disabled="!canAnalyze" @click="refreshAnalysis">해설 갱신</button>
    </div>

    <div v-if="!canAnalyze" class="analysis-empty">
      기보가 진행되면 현재까지의 수순으로 라이브 성향을 해석합니다. 수순 리뷰를 실행하면 엔진 손실과 응수 정보를 반영해 더 깊게 분석합니다.
    </div>

    <template v-else-if="analysis">
      <p class="summary">{{ analysis.summary }}</p>

      <div class="phase-visual">
        <div class="phase-ring" :style="ringStyle">
          <span>국면</span>
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
        <summary>초 / 한 분리 전략 프로파일</summary>
        <div class="side-analysis-grid">
          <article v-for="side in analysis.sides" :key="side.key" class="side-card">
            <header>
              <strong>{{ side.label }}</strong>
              <small>{{ side.moveCount }}수 · 평균 손실 {{ side.stats.acpl.toFixed(1) }}</small>
            </header>
            <div class="metric-grid compact">
              <div v-for="metric in sideMetrics(side.metrics)" :key="`${side.key}-${metric.key}`" class="metric-card">
                <span>{{ metric.label }}</span>
                <strong>{{ Math.round(metric.value) }}</strong>
                <div class="meter"><i :style="{ width: `${Math.round(metric.value)}%` }" /></div>
              </div>
            </div>
            <ul class="side-notes">
              <li v-for="line in side.narratives" :key="line">{{ line }}</li>
            </ul>
          </article>
        </div>
      </details>

      <details open class="meta-section">
        <summary>승부처 · 흐름 변동</summary>
        <div v-if="analysis.criticalEvents && analysis.criticalEvents.length" class="event-list">
          <article v-for="event in analysis.criticalEvents" :key="`${event.type}-${event.ply}-${event.sideKey}`" :class="['event-card', event.severity]">
            <strong>{{ event.title }}</strong>
            <p>{{ event.text }}</p>
          </article>
        </div>
        <p v-else class="quiet-note">큰 평가 급변보다 작은 선택들이 누적된 흐름입니다.</p>
      </details>

      <details open class="meta-section">
        <summary>AI · 기풍 유사도</summary>
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
        <summary>해설 노트</summary>
        <ul>
          <li v-for="line in analysis.narratives" :key="line">{{ line }}</li>
        </ul>
        <div v-if="analysis.comparativeNarratives && analysis.comparativeNarratives.length" class="comparison-notes">
          <strong>초·한 비교</strong>
          <ul>
            <li v-for="line in analysis.comparativeNarratives" :key="line">{{ line }}</li>
          </ul>
        </div>
        <div class="stats-row">
          <span>평균 손실 {{ analysis.stats.acpl.toFixed(1) }}</span>
          <span>최선 일치 {{ analysis.stats.top1.toFixed(1) }}%</span>
          <span>편차 {{ analysis.stats.stdDev.toFixed(1) }}</span>
          <span>치명 손실 {{ analysis.stats.blunder }}</span>
        </div>
        <small v-for="term in analysis.terms" :key="term" class="term">{{ term }}</small>
      </details>
    </template>
  </section>
</template>

<script>
import { analyzeGameReview, analyzeLiveGame, analyzeReviewSequence, phaseRingStyle } from '../../shared/review/gameAnalysis'

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
    playedMoves () {
      return this.$store.getters.moves || []
    },
    reviewSequence () {
      return this.$store.getters.reviewSequence
    },
    hasReviewResult () {
      return Boolean(this.reviewResult && Array.isArray(this.reviewResult.moves) && this.reviewResult.moves.length)
    },
    hasTemporaryLine () {
      return Boolean(this.reviewSequence && this.reviewSequence.active && Array.isArray(this.reviewSequence.line) && this.reviewSequence.line.length)
    },
    canAnalyze () {
      return Boolean(this.hasReviewResult || this.hasTemporaryLine || this.playedMoves.length)
    },
    analysis () {
      if (this.localAnalysis) return this.localAnalysis
      if (this.hasReviewResult) return analyzeGameReview(this.reviewResult)
      if (this.hasTemporaryLine) return analyzeReviewSequence(this.reviewSequence)
      return this.playedMoves.length ? analyzeLiveGame(this.playedMoves) : null
    },
    ringStyle () {
      return this.analysis ? phaseRingStyle(this.analysis.phases) : {}
    }
  },
  watch: {
    reviewResult () {
      this.localAnalysis = null
    },
    playedMoves () {
      if (!this.reviewResult) this.localAnalysis = null
    },
    reviewSequence () {
      this.localAnalysis = null
    }
  },
  methods: {
    refreshAnalysis () {
      this.localAnalysis = this.hasReviewResult
        ? analyzeGameReview(this.reviewResult)
        : (this.hasTemporaryLine ? analyzeReviewSequence(this.reviewSequence) : analyzeLiveGame(this.playedMoves))
    },
    sideMetrics (m) {
      if (!m) return []
      return [
        { key: 'tacticalDependence', label: '전술 의존도', value: m.tacticalDependence },
        { key: 'positionalPreference', label: '포지션 선호', value: m.positionalPreference },
        { key: 'aggression', label: '공격 성향', value: m.aggression },
        { key: 'stability', label: '안정성', value: m.stability },
        { key: 'practicality', label: '실전성', value: m.practicality },
        { key: 'riskProfile', label: '위험 감수', value: m.riskProfile },
        { key: 'strategicSharpness', label: '승부처 선명도', value: m.strategicSharpness },
        { key: 'conversionQuality', label: '전환 품질', value: m.conversionQuality },
        { key: 'defensiveResilience', label: '수비 복원력', value: m.defensiveResilience }
      ]
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
.side-analysis-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 8px;
  margin-top: 8px;
}
.side-card {
  padding: 8px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.10);
}
.side-card header {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: baseline;
}
.metric-grid.compact {
  grid-template-columns: repeat(auto-fit, minmax(105px, 1fr));
}
.side-notes,
.comparison-notes ul {
  margin-top: 8px;
  line-height: 1.45;
}
.event-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 8px;
}
.event-card {
  padding: 8px;
  border-left: 4px solid #7289da;
  border-radius: 5px;
  background: rgba(114, 137, 218, 0.12);
}
.event-card.warning { border-left-color: #f2994a; }
.event-card.critical { border-left-color: #d64545; }
.event-card.recovery { border-left-color: #2f855a; }
.event-card p {
  margin-top: 4px;
  line-height: 1.45;
}
.quiet-note,
.comparison-notes {
  margin-top: 8px;
}
@media (max-width: 780px) {
  .phase-visual { align-items: flex-start; }
  .phase-ring { width: 88px; height: 88px; }
}
</style>
