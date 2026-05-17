<template>
  <section class="review-panel panel">
    <div class="review-header">
      <div>
        <h3>수순 리뷰</h3>
        <p>엔진 추천과 사람의 아이디어를 함께 보는 코치형 검토입니다.</p>
      </div>
      <button
        type="button"
        class="review-clear"
        :disabled="!review.currentResult && !review.error && !(review.sequence && review.sequence.active)"
        @click="clearReview"
      >
        닫기
      </button>
    </div>

    <div
      v-if="review.sequence && review.sequence.active"
      class="sequence-banner"
    >
      <strong>임시 수순 검토 모드</strong>
      <span>임시 수순: {{ review.sequence.line.length }}수</span>
      <small>실제 기보와 분석 가지는 변경되지 않습니다.</small>
      <div
        v-if="review.sequence.sans.length"
        class="sequence-line"
      >
        {{ review.sequence.sans.join(' ') }}
      </div>
    </div>

    <div class="marker-mode-control">
      <label for="review-marker-mode">표시할 수</label>
      <select
        id="review-marker-mode"
        :value="review.markerMode"
        :disabled="review.loading"
        @change="setMarkerMode($event.target.value)"
      >
        <option
          v-for="mode in markerModes"
          :key="mode.value"
          :value="mode.value"
        >
          {{ mode.label }}
        </option>
      </select>
      <small>{{ markerModeHelp }}</small>
    </div>

    <div class="review-actions">
      <button
        v-if="!review.sequence.active"
        type="button"
        class="review-primary"
        :disabled="review.loading"
        @click="startReviewSequence"
      >
        수순 검토 시작
      </button>
      <template v-else>
        <button
          type="button"
          class="review-primary"
          :disabled="review.loading || review.sequence.line.length === 0"
          @click="reviewCurrentSequence"
        >
          {{ review.loading ? '검토 중…' : '수순 검토하기' }}
        </button>
        <div class="review-row">
          <button
            type="button"
            :disabled="review.sequence.line.length === 0"
            @click="clearReviewSequence"
          >
            임시 수순 지우기
          </button>
          <button
            type="button"
            @click="cancelReviewSequence"
          >
            검토 모드 종료
          </button>
        </div>
      </template>
      <button
        type="button"
        class="review-secondary"
        :disabled="review.loading"
        @click="reviewCurrentMove"
      >
        선택한 수 검토
      </button>
      <details class="manual-review">
        <summary>좌표 입력 보조 기능</summary>
        <div class="custom-review">
          <input
            v-model.trim="customMove"
            type="text"
            placeholder="좌표 수 입력 예: e3e4"
            @keyup.enter="reviewCustomMove"
          >
          <button
            type="button"
            :disabled="review.loading || !customMove"
            @click="reviewCustomMove"
          >
            아이디어 검토
          </button>
        </div>
        <div class="custom-review">
          <input
            v-model.trim="customLine"
            type="text"
            placeholder="짧은 수순 예: e3e4 e6e5"
            @keyup.enter="reviewLine"
          >
          <button
            type="button"
            :disabled="review.loading || !customLine"
            @click="reviewLine"
          >
            입력 수순 검토
          </button>
        </div>
      </details>
    </div>

    <div
      v-if="review.error"
      class="review-error"
    >
      {{ review.error }}
    </div>

    <div
      v-if="result"
      class="review-result"
    >
      <div class="review-summary-card">
        <div class="section-heading">
          <h4>요약</h4>
          <small>보드를 보면서 읽을 수 있도록 고정됩니다.</small>
        </div>
        <div class="classification">
          <span :class="['risk-badge', severityClass]">{{ severityLabel }}</span>
          <span class="intent-badge">{{ primaryIntentLabel }}</span>
          <span v-if="result.cached" class="cache-badge">캐시</span>
        </div>
        <p class="summary">
          {{ result.summary }}
        </p>
      </div>

      <details
        v-if="reviewedMoves.length"
        class="move-timeline review-section"
        open
        @mouseleave="clearPreview"
      >
        <summary>
          <strong>수순별 평가</strong>
          <small>{{ result.markerModeLabel || markerModeLabel(review.markerMode) }}</small>
        </summary>
        <div class="move-chip-list">
          <button
            v-for="move in reviewedMoves"
            :key="move.ply"
            type="button"
            :class="['move-chip', severityClassForMove(move), { active: selectedMove && selectedMove.ply === move.ply }]"
            @click="selectMove(move)"
            @mouseenter="previewMove(move)"
            @focus="previewMove(move)"
            @blur="clearPreview"
          >
            <span class="move-ply">{{ move.ply }}</span>
            <span class="move-main">{{ move.move }}</span>
            <span class="move-label">{{ move.classificationLabel }}</span>
          </button>
        </div>
        <div
          v-if="focusedMove"
          class="move-detail"
        >
          <strong>{{ focusedMove.ply }}수 · {{ focusedMove.sideLabel }} · {{ focusedMove.classificationLabel }}</strong>
          <p>{{ focusedMove.summary }}</p>
          <div class="move-meta">
            <span>{{ evalDeltaText(focusedMove) }}</span>
            <span>{{ practicalText(focusedMove) }}</span>
            <span>{{ confidence(focusedMove.confidence) }}</span>
          </div>
          <ul v-if="focusedMove.risks && focusedMove.risks.length">
            <li
              v-for="risk in focusedMove.risks"
              :key="risk.id"
            >
              {{ risk.text }}
            </li>
          </ul>
        </div>
      </details>

      <details
        v-if="responseMoves.length"
        class="review-section response-section"
        open
      >
        <summary>추천 응수</summary>
        <div class="response-list">
          <button
            v-for="move in responseMoves"
            :key="`response-${move.ply}`"
            type="button"
            class="response-card"
            @mouseenter="previewMove(move)"
            @mouseleave="clearPreview"
            @focus="previewMove(move)"
            @blur="clearPreview"
            @click="selectMove(move)"
          >
            <strong>{{ move.move }}</strong>
            <span v-if="move.punishmentMove">{{ move.punishmentMove }} 응수 확인</span>
            <span v-else-if="move.bestMove">{{ move.bestMove }}와 비교</span>
            <small>{{ move.summary }}</small>
          </button>
        </div>
      </details>


      <details
        v-if="result.engineRecommendations && result.engineRecommendations.length"
        class="review-section recommendations"
      >
        <summary>엔진 추천</summary>
        <ol>
          <li
            v-for="rec in result.engineRecommendations.slice(0, 3)"
            :key="rec.rank"
          >
            <strong>추천수 {{ rec.rank }}: {{ rec.move }}</strong>
            <span>{{ evalText(rec) }}</span>
            <small>{{ rec.meaning }}</small>
          </li>
        </ol>
      </details>

      <div class="review-grid">
        <div>
          <strong>검토 수</strong>
          <span>{{ result.reviewedMove || '—' }}</span>
        </div>
        <div>
          <strong>엔진 1순위</strong>
          <span>{{ result.engineEvidence && result.engineEvidence.bestMove ? result.engineEvidence.bestMove : '—' }}</span>
        </div>
      </div>

      <details
        v-if="result.ideas && result.ideas.length"
        class="review-section"
      >
        <summary>전략 의도</summary>
        <ul>
          <li
            v-for="idea in result.ideas"
            :key="idea.id"
          >
            {{ idea.text }} <small>({{ confidence(idea.confidence) }})</small>
          </li>
        </ul>
      </details>

      <details
        v-if="result.risks && result.risks.length"
        class="review-section danger"
        open
      >
        <summary>핵심 위험</summary>
        <ul>
          <li
            v-for="risk in result.risks"
            :key="risk.id"
          >
            {{ risk.text }} <small>{{ severityText(risk.severity) }} · {{ confidence(risk.confidence) }}</small>
          </li>
        </ul>
      </details>

      <details
        v-if="result.risks && result.risks.length"
        class="review-section danger-explain"
      >
        <summary>상대 응징/전술 설명</summary>
        <p>{{ result.risks[0].text }}</p>
      </details>

      <details
        v-if="result.keyMoments && result.keyMoments.length"
        class="review-section"
      >
        <summary>핵심 장면</summary>
        <ol>
          <li
            v-for="moment in result.keyMoments"
            :key="moment.ply"
          >
            <strong>{{ moment.move }}</strong> — {{ moment.label }}
            <small>{{ moment.text }}</small>
          </li>
        </ol>
      </details>

      <div class="overlay-legend">
        <span><i class="legend-red" /> 위험 / 응징</span>
        <span><i class="legend-orange" /> 공격 아이디어</span>
        <span><i class="legend-blue" /> 수순 진행</span>
      </div>

      <div
        v-if="result.overlays && result.overlays.length"
        class="overlay-note"
      >
        {{ result.overlays.length }}개의 리뷰 표시가 보드에 표시됩니다.
      </div>
    </div>

    <div
      v-else-if="!review.error"
      class="review-empty"
    >
      수순 검토 시작을 누른 뒤 보드에서 직접 임시 수순을 진행해 주세요. 실제 기보는 바뀌지 않으며, 선택한 기보의 한 수도 따로 검토할 수 있습니다.
    </div>
  </section>
</template>

<script>
import { mapGetters } from 'vuex'

export default {
  name: 'ReviewPanel',
  beforeDestroy () {
    this.$store.dispatch('clearReviewPreview')
  },
  data () {
    return {
      customMove: '',
      customLine: '',
      selectedPly: null,
      hoveredMove: null,
      markerModes: [
        { value: 'FIRST_MOVE_ONLY', label: '첫 수만', help: '첫 번째 수만 빠르게 확인합니다.' },
        { value: 'MY_MOVES_ONLY', label: '내 수만', help: '첫 수를 내 수로 보고 내 수마다 표시합니다.' },
        { value: 'OPPONENT_MOVES_ONLY', label: '상대 수만', help: '상대 응수만 따로 확인합니다.' },
        { value: 'BOTH_SIDES', label: '양쪽 모두', help: '수순의 모든 수를 차례대로 표시합니다.' }
      ]
    }
  },
  computed: {
    ...mapGetters(['review']),
    result () {
      return this.review.currentResult
    },
    reviewedMoves () {
      if (!this.result) return []
      if (Array.isArray(this.result.markerMoves) && this.result.markerMoves.length) return this.result.markerMoves
      return Array.isArray(this.result.moves) ? this.result.moves : []
    },
    responseMoves () {
      return this.reviewedMoves
        .filter(move => move && (move.punishmentMove || move.bestMove || (move.risks && move.risks.length)))
        .slice(0, 4)
    },
    selectedMove () {
      if (!this.reviewedMoves.length) return null
      return this.reviewedMoves.find(move => move.ply === this.selectedPly) || this.reviewedMoves[0]
    },
    focusedMove () {
      return this.hoveredMove || this.selectedMove
    },
    markerModeHelp () {
      const mode = this.markerModes.find(mode => mode.value === this.review.markerMode)
      return mode ? mode.help : '첫 수를 내 수로 보고 표시합니다.'
    },
    classificationLabel () {
      if (!this.result || !this.result.classification) return '리뷰'
      return this.classificationText(this.result.classification)
    },
    severityLabel () {
      if (!this.result) return '준비됨'
      if (this.result.classificationLabel) return this.result.classificationLabel
      if (this.result.risks && this.result.risks.find(risk => risk.severity === 'high')) return '확인 필요'
      if (this.result.risks && this.result.risks.length) return '검토 포인트'
      return this.classificationLabel
    },
    severityClass () {
      if (!this.result) return 'neutral'
      if (this.result.classification) return this.result.classification
      return 'neutral'
    },
    primaryIntentLabel () {
      const intent = this.result && this.result.ideas && this.result.ideas[0]
      return intent ? (intent.label || this.intentTypeText(intent.type)) : '아이디어 검토'
    }
  },
  methods: {
    setMarkerMode (mode) {
      this.selectedPly = null
      this.$store.dispatch('setReviewMarkerMode', mode)
    },
    markerModeLabel (mode) {
      const found = this.markerModes.find(item => item.value === mode)
      return found ? found.label : '내 수만'
    },
    selectMove (move) {
      this.selectedPly = move && move.ply
      this.previewMove(move)
    },
    previewMove (move) {
      this.hoveredMove = move
      if (move && move.previewFen) {
        this.$store.dispatch('previewReviewMove', move)
      }
    },
    clearPreview () {
      this.hoveredMove = null
      this.$store.dispatch('clearReviewPreview')
    },
    severityClassForMove (move) {
      return move && move.severity ? move.severity : 'neutral'
    },
    evalDeltaText (move) {
      if (!move || typeof move.loss !== 'number') return '평가 차이 없음'
      if (move.loss < 30) return '엔진 차이 거의 없음'
      return `평가 차이 약 ${Math.round(move.loss)}cp`
    },
    practicalText (move) {
      if (!move || !move.practical) return '실전 요소 보통'
      const parts = []
      if (move.practical.attackChances) parts.push('공격 기회')
      if (move.practical.complexityIncrease) parts.push('복잡성')
      if (move.practical.initiative) parts.push('주도권')
      if (move.practical.defensiveConcern) parts.push('수비 확인')
      return parts.length ? parts.join(' · ') : '안정성'
    },
    startReviewSequence () {
      this.$store.dispatch('startReviewSequence')
    },
    reviewCurrentSequence () {
      this.$store.dispatch('reviewCurrentSequence')
    },
    clearReviewSequence () {
      this.$store.dispatch('clearReviewSequence')
    },
    cancelReviewSequence () {
      this.$store.dispatch('cancelReviewSequence')
    },
    reviewCurrentMove () {
      this.$store.dispatch('reviewCurrentMove')
    },
    reviewCustomMove () {
      this.$store.dispatch('reviewCustomMove', this.customMove)
    },
    reviewLine () {
      this.$store.dispatch('reviewLine', this.customLine.split(/\s+/).filter(Boolean))
    },
    clearReview () {
      this.$store.dispatch('clearReview')
    },
    confidence (value) {
      if (typeof value !== 'number') return '신뢰도 없음'
      return `신뢰도 ${Math.round(value * 100)}%`
    },
    intentTypeText (type) {
      const labels = {
        develop_piece: '기물 전개',
        central_pressure: '중앙 압박',
        side_attack: '측면 공격',
        king_safety: '왕 안전',
        material_gain: '이득 노림',
        sequence_plan_direction: '수순 방향성',
        engine_recommendation: '엔진 추천',
        tactical_warning: '전술 경고'
      }
      return labels[type] || '아이디어 검토'
    },
    classificationText (classification) {
      const labels = {
        excellent: '훌륭한 수',
        good: '좋은 수',
        natural: '자연스러운 수',
        practical: '실전적인 수',
        complexity: '복잡성을 높이는 수',
        attacking_try: '공격적인 시도',
        interesting_risk: '위험하지만 흥미로운 수',
        needs_care: '주의가 필요한 수',
        inaccuracy: '부정확한 수',
        mistake: '실수',
        blunder: '큰 실수',
        engine_supported_idea: '엔진도 지지',
        high_risk: '확인 필요',
        practical_but_risky: '실전적 시도',
        risky_practical_try: '복잡한 실전 수',
        playable_alternative: '둘 만한 대안',
        needs_tactical_check: '확인할 후보',
        idea_review: '아이디어 검토',
        no_move: '수 없음'
      }
      return labels[classification] || '리뷰'
    },
    severityText (severity) {
      if (severity === 'high') return '위험 높음'
      if (severity === 'medium') return '주의'
      if (severity === 'low') return '낮음'
      return severity || '정보 없음'
    },
    evalText (rec) {
      if (rec && typeof rec.mate === 'number') return `메이트 ${rec.mate}`
      if (!rec || typeof rec.cp !== 'number') return '평가 없음'
      const pawns = (rec.cp / 100).toFixed(2)
      return `${rec.cp >= 0 ? '+' : ''}${pawns}`
    }
  }
}
</script>

<style scoped>
.review-panel {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  min-height: 0;
  max-height: min(52vh, 660px);
  margin: 10px 0;
  padding: 0;
  background: var(--second-bg-color);
  border: 1px solid var(--main-border-color);
  border-radius: 6px;
  color: var(--main-text-color);
  font-size: 12px;
  text-align: left;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
}
.review-header {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 10px;
  background: var(--second-bg-color);
  border-bottom: 1px solid var(--main-border-color);
}
h3, h4, p {
  margin: 0;
}
.review-header p,
.review-empty,
.overlay-note {
  color: var(--second-text-color, #9aa0a6);
}
.sequence-banner {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 10px;
  padding: 9px;
  border: 1px solid rgba(242, 153, 74, 0.6);
  border-radius: 6px;
  background: rgba(242, 153, 74, 0.12);
}
.sequence-line {
  margin-top: 4px;
  padding: 5px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.18);
  font-family: monospace;
}

.sequence-banner,
.marker-mode-control,
.review-actions,
.review-error,
.review-empty {
  margin-left: 10px;
  margin-right: 10px;
}
.marker-mode-control {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 10px;
  padding: 8px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.10);
}
.marker-mode-control label {
  font-weight: 800;
}
.marker-mode-control select {
  padding: 5px;
  border: 1px solid var(--main-border-color);
  border-radius: 4px;
  background: var(--second-bg-color);
  color: var(--main-text-color);
}
.move-timeline {
  padding: 8px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.08);
}
.section-heading {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}
.move-chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.move-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  border: 1px solid rgba(255, 255, 255, 0.25);
  background: rgba(77, 102, 128, 0.7);
  color: #fff;
  font-size: 11px;
}
.move-chip.active {
  outline: 2px solid #fff;
}
.move-chip:focus,
.response-card:focus {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
.move-chip.excellent { background: #2f855a; }
.move-chip.good,
.move-chip.natural { background: #3f6fb5; }
.move-chip.practical,
.move-chip.attacking_try,
.move-chip.complexity,
.move-chip.interesting_risk,
.move-chip.risky { background: #a05f00; }
.move-chip.needs_care,
.move-chip.caution,
.move-chip.inaccuracy { background: #9a6700; }
.move-chip.mistake,
.move-chip.blunder { background: #b42336; }
.move-ply {
  font-weight: 900;
}
.move-label {
  opacity: 0.95;
}
.move-detail {
  margin-top: 8px;
  padding: 8px;
  border-left: 4px solid #7289da;
  border-radius: 4px;
  background: rgba(114, 137, 218, 0.12);
}
.move-detail p {
  margin-top: 4px;
  line-height: 1.35;
}
.move-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 5px;
}
.move-meta span {
  padding: 2px 5px;
  border-radius: 999px;
  background: rgba(127, 127, 127, 0.20);
  font-size: 10px;
}

.response-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 6px;
  margin-top: 6px;
}
.response-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  border: 1px solid rgba(242, 201, 76, 0.55);
  background: rgba(242, 201, 76, 0.12);
  color: var(--main-text-color);
  text-align: left;
}
.response-card strong {
  color: #ffd86b;
}
.response-card small {
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.review-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}
.review-row {
  display: flex;
  gap: 6px;
}
.review-secondary {
  background: #4d6680;
  color: white;
}
.manual-review {
  padding: 6px;
  border-radius: 4px;
  background: rgba(127, 127, 127, 0.08);
}
.manual-review summary {
  cursor: pointer;
}
.custom-review {
  display: flex;
  gap: 6px;
}
.custom-review input {
  min-width: 0;
  flex: 1;
}
button {
  border: none;
  border-radius: 4px;
  padding: 6px 8px;
  cursor: pointer;
}
button:disabled {
  cursor: default;
  opacity: 0.55;
}
.review-primary {
  background: #7289da;
  color: white;
}
.review-clear {
  align-self: flex-start;
  background: #555;
  color: white;
}
.review-error {
  margin-top: 10px;
  padding: 9px;
  border: 1px solid #ff6b6b;
  border-left: 5px solid #ff2e3f;
  border-radius: 5px;
  background: rgba(199, 38, 52, 0.28);
  color: #fff1f1;
  font-weight: 700;
}
.review-result {
  margin-top: 10px;
  padding: 0 10px 10px;
  overflow: visible;
}
.review-summary-card {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 8px;
  border: 1px solid rgba(114, 137, 218, 0.35);
  border-radius: 6px;
  background: var(--second-bg-color);
  box-shadow: 0 6px 12px rgba(0, 0, 0, 0.18);
}
.review-result details {
  margin-top: 8px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.08);
}
.review-result summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
  padding: 7px;
  font-weight: 800;
}
.review-result details > *:not(summary) {
  margin-left: 8px;
  margin-right: 8px;
}
.review-result details[open] {
  padding-bottom: 8px;
}
.classification {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-weight: 700;
  text-transform: capitalize;
}
.classification span {
  margin-left: 0;
  padding: 4px 8px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.45);
  background: rgba(114, 137, 218, 0.82);
  color: #fff;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.01em;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.28);
}
.risk-badge.excellent { background: #2f855a; color: #fff; border-color: #9be7b0; }
.risk-badge.good,
.risk-badge.natural { background: #3f6fb5; color: #fff; border-color: #aac7ff; }
.risk-badge.practical,
.risk-badge.attacking_try,
.risk-badge.complexity,
.risk-badge.interesting_risk,
.risk-badge.risky { background: #a05f00; color: #fffaf1; border-color: #ffd08a; }
.risk-badge.needs_care,
.risk-badge.caution,
.risk-badge.inaccuracy { background: #9a6700; color: #fffaf1; border-color: #ffd08a; }
.risk-badge.mistake,
.risk-badge.blunder,
.risk-badge.high { background: #d7263d; color: #fff; border-color: #ffb3b3; }
.risk-badge.medium { background: #c46b00; color: #fffaf1; border-color: #ffd08a; }
.risk-badge.low { background: #247a3d; color: #f0fff4; border-color: #9be7b0; }
.risk-badge.neutral { background: #4d6680; color: #fff; }
.intent-badge { background: #4158b8; color: #fff; }
.cache-badge { background: #595f68; color: #fff; }
.summary {
  margin-top: 6px;
  line-height: 1.4;
}
.review-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin: 10px 0;
}
.review-grid div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  border-radius: 4px;
  background: rgba(127, 127, 127, 0.12);
}
.review-section {
  margin-top: 8px;
}
ul, ol {
  margin: 4px 0 0 16px;
  padding: 0;
}
li + li {
  margin-top: 4px;
}
.review-section ol small {
  display: block;
  margin-top: 2px;
}
.overlay-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
  font-size: 11px;
}
.overlay-legend span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.overlay-legend i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}
.legend-red { background: #c72634; }
.legend-orange { background: #f2994a; }
.legend-blue { background: #7289da; }
small {
  color: var(--second-text-color, #9aa0a6);
}
.danger,
.danger-explain {
  padding: 8px;
  border: 1px solid rgba(255, 107, 107, 0.75);
  border-left: 5px solid #ff2e3f;
  border-radius: 6px;
  background: rgba(199, 38, 52, 0.18);
}
.danger h4,
.danger-explain h4 {
  color: #ff6b6b;
  font-weight: 900;
}
.danger li,
.danger-explain p {
  color: var(--main-text-color);
  font-weight: 700;
}
.danger small {
  color: #ffd0d0;
  font-weight: 800;
}
.review-empty {
  margin-top: 10px;
  line-height: 1.4;
}
@media (max-width: 1100px) {
  .review-panel {
    max-height: none;
    overflow: visible;
  }
}

@media (max-width: 780px) {
  .review-panel {
    flex: 0 0 auto;
    max-height: none;
  }
  .review-grid,
  .response-list {
    grid-template-columns: 1fr;
  }
}

</style>
