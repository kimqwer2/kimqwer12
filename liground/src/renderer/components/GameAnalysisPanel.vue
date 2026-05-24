<template>
  <section class="game-analysis panel">
    <div class="analysis-title">
      <div>
        <h3>기보 메타 분석</h3>
        <p>엔진 리뷰와 현재 수순 흐름 위에 올리는 전략·성향 해설입니다.</p>
      </div>
      <div class="analysis-actions">
        <label class="realtime-toggle"><input v-model="realTimeCommentary" type="checkbox"> 실시간 전략 해설</label>
        <button type="button" :disabled="!canAnalyze" @click="refreshAnalysis">해설 갱신</button>
        <button type="button" :disabled="!canReviewCurrentGame" @click="reviewCurrentGame">현재 기보 엔진 반영</button>
      </div>
    </div>

    <div v-if="!canAnalyze" class="analysis-empty">
      기보가 진행되면 현재까지의 수순으로 라이브 성향을 해석합니다. 수순 리뷰를 실행하면 엔진 손실과 응수 정보를 반영해 더 깊게 분석합니다.
    </div>

    <template v-else-if="analysis">
      <div class="context-line">
        현재 해설 기준: <strong>{{ contextLabel }}</strong>
        <span v-if="reviewLoading">엔진 리뷰 반영 중…</span>
      </div>
      <p class="summary">{{ analysis.summary }}</p>

      <div class="phase-visual">
        <div class="phase-ring" :style="ringStyle">
          <span>AI 유사도</span>
        </div>
        <div class="phase-list">
          <div v-for="phase in analysis.phases" :key="phase.key" class="phase-row">
            <span class="phase-dot" :style="{ backgroundColor: phase.color }" />
            <strong>{{ phase.label }} AI 일치율</strong>
            <span>{{ similarityText(phase.aiSimilarity) }}</span>
            <small>{{ lossText(phase.acpl) }} · {{ phase.count }}수</small>
          </div>
        </div>
      </div>

      <details open class="meta-section">
        <summary>초 / 한 분리 전략 프로파일</summary>
        <div class="side-analysis-grid">
          <article v-for="side in analysis.sides" :key="side.key" class="side-card">
            <header>
              <strong>{{ side.label }}</strong>
              <small>{{ sideStatText(side) }}</small>
            </header>
            <div v-if="side.moveCount" class="side-ai-summary">
              <span>AI 유사도 <strong>{{ Math.round(side.metrics.engineLike) }}%</strong></span>
              <span>평균 형세 손실 <strong>{{ side.stats.acpl.toFixed(1) }}</strong></span>
            </div>
            <div v-if="side.moveCount" class="side-phase-list">
              <div v-for="phase in side.phases" :key="`${side.key}-${phase.key}`" class="side-phase-row">
                <span>{{ phase.label }}</span>
                <div class="meter"><i :style="{ width: `${Math.round(phase.aiSimilarity)}%` }" /></div>
                <strong>{{ Math.round(phase.aiSimilarity) }}%</strong>
              </div>
            </div>
            <div v-if="side.moveCount" class="metric-grid compact">
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
        <summary>초 / 한 AI 기풍 유사도</summary>
        <div class="side-style-grid">
          <article v-for="side in analysis.sides" :key="`${side.key}-style`" class="side-style-card">
            <header>
              <strong>{{ side.label }} 기풍</strong>
              <small>{{ side.moveCount ? `전체 AI 유사도 ${Math.round(side.metrics.engineLike)}%` : '데이터 부족' }}</small>
            </header>
            <div v-if="side.moveCount" class="similarity-list">
              <div v-for="item in side.similarity" :key="`${side.key}-${item.key}`" class="similarity-row">
                <div>
                  <strong>{{ item.label }}</strong>
                  <small>{{ item.text }}</small>
                </div>
                <span>{{ Math.round(item.value) }}%</span>
              </div>
            </div>
            <p v-else class="quiet-note">아직 {{ side.label }}의 수가 충분하지 않아 기풍 유사도를 분리하기 어렵습니다.</p>
          </article>
        </div>
      </details>

      <details class="meta-section">
        <summary>해설 노트</summary>
        <div v-if="analysis.flowNarratives && analysis.flowNarratives.length" class="flow-notes">
          <strong>대국 흐름</strong>
          <ul>
            <li v-for="line in analysis.flowNarratives" :key="line">{{ line }}</li>
          </ul>
        </div>
        <strong>핵심 해설</strong>
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
          <span>평균 형세 손실 {{ analysis.stats.acpl.toFixed(1) }}</span>
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

function sameLine (left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  return left.every((move, idx) => move === right[idx])
}

export default {
  name: 'GameAnalysisPanel',
  data () {
    return {
      localAnalysis: null,
      realtimeTimer: null,
      lastRealtimeReviewKey: '',
      realtimeSessionId: 0
    }
  },
  computed: {
    review () {
      return this.$store.getters.review || {}
    },
    reviewResult () {
      return this.$store.getters.reviewResult
    },
    reviewPreview () {
      return this.$store.getters.reviewPreview
    },
    reviewLoading () {
      return Boolean(this.review && this.review.loading)
    },
    cfg () {
      return this.$store.getters.analysisVisualization || {}
    },
    realTimeCommentary: {
      get () {
        return Boolean(this.cfg.realtimeGameCommentary)
      },
      set (value) {
        this.$store.dispatch('analysisVisualization', { realtimeGameCommentary: Boolean(value) })
      }
    },
    reviewSequence () {
      return this.$store.getters.reviewSequence
    },
    playedMoves () {
      return this.$store.getters.moves || []
    },
    currentMove () {
      const current = this.$store.getters.currentMove
      return Array.isArray(current) ? current[0] : null
    },
    mainFirstMove () {
      return this.$store.getters.mainFirstMove
    },
    startFen () {
      return this.$store.getters.startFen
    },
    activePlayedLine () {
      if (!this.playedMoves.length) return []
      if (this.currentMove) return this.lineToMove(this.currentMove)
      const first = this.mainFirstMove || this.playedMoves.find(move => move && !move.prev) || this.playedMoves[0]
      const line = []
      const seen = new Set()
      let cursor = first
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor)
        line.push(cursor)
        cursor = cursor.main || (Array.isArray(cursor.next) ? cursor.next[0] : null)
      }
      return line.length ? line : this.playedMoves
    },
    activePlayedUci () {
      return this.activePlayedLine.map(move => move.uci || move.move).filter(Boolean)
    },
    activePlayedSans () {
      return this.activePlayedLine.map(move => move.name || move.move || move.uci || '').filter(Boolean)
    },
    hasReviewResult () {
      return Boolean(this.reviewResult && Array.isArray(this.reviewResult.moves) && this.reviewResult.moves.length)
    },
    hasTemporaryLine () {
      return Boolean(this.reviewSequence && this.reviewSequence.active && Array.isArray(this.reviewSequence.line) && this.reviewSequence.line.length)
    },
    reviewResultMatchesActivePlayedLine () {
      return this.activePlayedUci.length > 0 && this.resultMatchesLine(this.activePlayedUci, this.startFen)
    },
    reviewResultIsPlayedLine () {
      if (!this.hasReviewResult) return false
      const ctx = this.reviewResult.requestContext || {}
      return Boolean(ctx.manualGame || ctx.source === 'played-line' || ctx.source === 'realtime-played-line')
    },
    previewReviewResult () {
      if (!this.realTimeCommentary || !this.hasReviewResult || !this.reviewPreview || !this.reviewPreview.active || !this.reviewPreview.move) return null
      const ply = this.reviewPreview.move.ply
      if (!ply) return null
      const moves = this.reviewResult.moves.filter(move => move.ply <= ply)
      if (!moves.length) return null
      return {
        ...this.reviewResult,
        moves,
        markerMoves: Array.isArray(this.reviewResult.markerMoves) ? this.reviewResult.markerMoves.filter(move => move.ply <= ply) : this.reviewResult.markerMoves,
        reviewedLine: moves.map(move => move.move).filter(Boolean),
        requestContext: { ...(this.reviewResult.requestContext || {}), source: 'hover-preview', previewPly: ply }
      }
    },
    activeAnalysisContext () {
      if (this.previewReviewResult) {
        return {
          key: `preview:${this.reviewResult.id || ''}:${this.reviewPreview.move.ply}`,
          label: `수순별 평가 ${this.reviewPreview.move.ply}수까지`,
          analysis: analyzeGameReview(this.previewReviewResult)
        }
      }
      if (this.hasReviewResult) {
        const ctx = this.reviewResult.requestContext || {}
        const stalePlayedReview = this.reviewResultIsPlayedLine && this.activePlayedUci.length && !this.reviewResultMatchesActivePlayedLine
        if (!stalePlayedReview) {
          const label = ctx.temporary ? '임시 수순 엔진 리뷰' : (ctx.manualGame || ctx.source === 'played-line' || ctx.source === 'realtime-played-line' ? '현재 기보 엔진 리뷰' : '수순 리뷰 결과')
          return {
            key: `review:${this.reviewResult.id || ''}:${this.reviewResult.generatedAt || ''}`,
            label,
            analysis: analyzeGameReview(this.reviewResult)
          }
        }
      }
      if (this.hasTemporaryLine) {
        return {
          key: `temporary:${this.reviewSequence.baseFen || ''}:${this.reviewSequence.line.join(' ')}`,
          label: '임시 수순 실시간 해석',
          analysis: analyzeReviewSequence(this.reviewSequence)
        }
      }
      if (this.activePlayedLine.length) {
        const tail = this.activePlayedUci.slice(-4).join(' ')
        return {
          key: `played:${this.startFen || ''}:${this.activePlayedUci.length}:${tail}`,
          label: '현재 기보 흐름',
          analysis: analyzeLiveGame(this.activePlayedLine)
        }
      }
      return null
    },
    activeContextKey () {
      return this.activeAnalysisContext ? this.activeAnalysisContext.key : ''
    },
    contextLabel () {
      return this.activeAnalysisContext ? this.activeAnalysisContext.label : '분석 대기'
    },
    canAnalyze () {
      return Boolean(this.activeAnalysisContext)
    },
    canReviewCurrentGame () {
      return Boolean(this.activePlayedUci.length)
    },
    analysis () {
      return this.localAnalysis || (this.activeAnalysisContext ? this.activeAnalysisContext.analysis : null)
    },
    ringStyle () {
      return this.analysis ? phaseRingStyle(this.analysis.phases) : {}
    },
    realtimeReviewKey () {
      if (!this.realTimeCommentary || this.reviewLoading) return ''
      if (this.hasTemporaryLine && !this.resultMatchesLine(this.reviewSequence.line, this.reviewSequence.baseFen)) {
        const tempLine = this.reviewSequence.line || []
        return `temporary:${this.reviewSequence.baseFen || ''}:${tempLine.length}:${tempLine.slice(-6).join(' ')}`
      }
      if (!this.hasTemporaryLine && this.activePlayedUci.length >= 2 && !this.reviewResultMatchesActivePlayedLine) {
        return `played:${this.startFen || ''}:${this.activePlayedUci.length}:${this.activePlayedUci.slice(-6).join(' ')}`
      }
      return ''
    }
  },
  watch: {
    activeContextKey () {
      this.localAnalysis = null
    },
    realtimeReviewKey: {
      immediate: true,
      handler () {
        this.scheduleRealtimeReview()
      }
    },
    realTimeCommentary (enabled) {
      if (!enabled) this.clearRealtimeTimer()
      else this.scheduleRealtimeReview()
    }
  },
  beforeDestroy () {
    this.clearRealtimeTimer()
  },
  methods: {
    lineToMove (move) {
      const line = []
      const seen = new Set()
      let cursor = move
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor)
        line.unshift(cursor)
        cursor = cursor.prev
      }
      return line
    },
    resultMatchesLine (line, fen) {
      if (!this.hasReviewResult || !Array.isArray(line)) return false
      if (fen && this.reviewResult.fen && fen !== this.reviewResult.fen) return false
      return sameLine(this.reviewResult.reviewedLine || [], line)
    },
    clearRealtimeTimer () {
      if (this.realtimeTimer) clearTimeout(this.realtimeTimer)
      this.realtimeTimer = null
    },
    scheduleRealtimeReview () {
      this.clearRealtimeTimer()
      const key = this.realtimeReviewKey
      if (!key || key === this.lastRealtimeReviewKey) return
      const sessionId = ++this.realtimeSessionId
      this.realtimeTimer = setTimeout(() => {
        if (sessionId !== this.realtimeSessionId || key !== this.realtimeReviewKey || this.reviewLoading) return
        this.lastRealtimeReviewKey = key
        if (key.startsWith('temporary:')) {
          this.$store.dispatch('reviewCurrentSequence')
        } else if (key.startsWith('played:')) {
          this.$store.dispatch('reviewPlayedLine', {
            fen: this.startFen,
            line: this.activePlayedUci,
            sans: this.activePlayedSans,
            manualGame: true,
            source: 'realtime-played-line',
            incremental: true,
            realtimeSessionId: sessionId
          })
        }
      }, 1500)
    },
    refreshAnalysis () {
      this.localAnalysis = this.activeAnalysisContext ? this.activeAnalysisContext.analysis : null
    },
    reviewCurrentGame () {
      this.clearRealtimeTimer()
      this.lastRealtimeReviewKey = ''
      this.$store.dispatch('reviewPlayedLine', {
        fen: this.startFen,
        line: this.activePlayedUci,
        sans: this.activePlayedSans,
        manualGame: true,
        source: 'played-line',
        fullRebuild: true
      })
    },
    sideStatText (side) {
      if (!side || !side.moveCount) return '분석할 수순 없음'
      return `${side.moveCount}수 · 평균 형세 손실 ${side.stats.acpl.toFixed(1)}`
    },
    sideMetrics (m) {
      if (!m) return []
      return [
        { key: 'tacticalDependence', label: '전술 의존도', value: m.tacticalDependence },
        { key: 'positionalPreference', label: '포지션 선호', value: m.positionalPreference },
        { key: 'aggression', label: '공격 성향', value: m.aggression },
        { key: 'stability', label: '안정성', value: m.stability },
        { key: 'practicality', label: '실전성', value: m.practicality },
        { key: 'choiceAccuracy', label: '선택 국면', value: m.choiceAccuracy },
        { key: 'chaosAccuracy', label: '난전 대응', value: m.chaosAccuracy },
        { key: 'riskProfile', label: '위험 감수', value: m.riskProfile },
        { key: 'strategicSharpness', label: '승부처 선명도', value: m.strategicSharpness },
        { key: 'defensiveResilience', label: '수비 복원력', value: m.defensiveResilience }
      ]
    },
    lossText (value) {
      return typeof value === 'number' ? `평균 형세 손실 ${value.toFixed(1)}` : '데이터 부족'
    },
    similarityText (value) {
      return typeof value === 'number' ? `${Math.round(value)}%` : '데이터 부족'
    },
    qualityText (value) {
      if (value >= 75) return 'AI 유사도 높음'
      if (value >= 45) return 'AI 유사도 보통'
      return 'AI 유사도 낮음'
    }
  }
}
</script>

<style scoped>
.game-analysis {
  flex: 0 0 auto;
  max-height: min(46vh, 620px);
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
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
.analysis-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}
.realtime-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 7px;
  border-radius: 4px;
  background: rgba(127, 127, 127, 0.10);
  white-space: nowrap;
}
.context-line {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
  color: var(--second-text-color, #9aa0a6);
}
.context-line span {
  color: #f2c94c;
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
.side-card header,
.side-style-card header {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: baseline;
}
.side-ai-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.side-ai-summary span {
  padding: 4px 6px;
  border-radius: 999px;
  background: rgba(114, 137, 218, 0.16);
}
.side-phase-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 8px;
}
.side-phase-row {
  display: grid;
  grid-template-columns: 42px 1fr 42px;
  gap: 6px;
  align-items: center;
}
.side-phase-row strong { text-align: right; }
.metric-grid.compact {
  grid-template-columns: repeat(auto-fit, minmax(105px, 1fr));
}
.side-style-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(245px, 1fr));
  gap: 8px;
  margin-top: 8px;
}
.side-style-card {
  padding: 8px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.10);
}
.side-notes,
.comparison-notes ul,
.flow-notes ul {
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
.comparison-notes,
.flow-notes {
  margin-top: 8px;
}
@media (max-width: 780px) {
  .game-analysis { max-height: none; overflow: visible; }
  .analysis-title { flex-direction: column; }
  .analysis-actions { justify-content: flex-start; }
  .phase-visual { align-items: flex-start; }
  .phase-ring { width: 88px; height: 88px; }
}
</style>
