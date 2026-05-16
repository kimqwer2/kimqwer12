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
      <div class="classification">
        <span :class="['risk-badge', severityClass]">{{ severityLabel }}</span>
        <span class="intent-badge">{{ primaryIntentLabel }}</span>
        <span v-if="result.cached" class="cache-badge">캐시</span>
      </div>
      <p class="summary">
        {{ result.summary }}
      </p>

      <div
        v-if="result.engineRecommendations && result.engineRecommendations.length"
        class="review-section recommendations"
      >
        <h4>엔진 추천수</h4>
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
      </div>

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

      <div
        v-if="result.ideas && result.ideas.length"
        class="review-section"
      >
        <h4>의도 해석</h4>
        <ul>
          <li
            v-for="idea in result.ideas"
            :key="idea.id"
          >
            {{ idea.text }} <small>({{ confidence(idea.confidence) }})</small>
          </li>
        </ul>
      </div>

      <div
        v-if="result.risks && result.risks.length"
        class="review-section danger"
      >
        <h4>주의할 점</h4>
        <ul>
          <li
            v-for="risk in result.risks"
            :key="risk.id"
          >
            {{ risk.text }} <small>{{ severityText(risk.severity) }} · {{ confidence(risk.confidence) }}</small>
          </li>
        </ul>
      </div>

      <div
        v-if="result.risks && result.risks.length"
        class="review-section danger-explain"
      >
        <h4>왜 위험한가?</h4>
        <p>{{ result.risks[0].text }}</p>
      </div>

      <div
        v-if="result.keyMoments && result.keyMoments.length"
        class="review-section"
      >
        <h4>핵심 장면</h4>
        <ol>
          <li
            v-for="moment in result.keyMoments"
            :key="moment.ply"
          >
            <strong>{{ moment.move }}</strong> — {{ moment.label }}
            <small>{{ moment.text }}</small>
          </li>
        </ol>
      </div>

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
  data () {
    return {
      customMove: '',
      customLine: ''
    }
  },
  computed: {
    ...mapGetters(['review']),
    result () {
      return this.review.currentResult
    },
    classificationLabel () {
      if (!this.result || !this.result.classification) return '리뷰'
      return this.classificationText(this.result.classification)
    },
    severityLabel () {
      if (!this.result) return '준비됨'
      if (this.result.risks && this.result.risks.find(risk => risk.severity === 'high')) return '위험도 높음'
      if (this.result.risks && this.result.risks.length) return '주의 필요'
      return this.classificationLabel
    },
    severityClass () {
      if (!this.result || !this.result.risks) return 'neutral'
      if (this.result.risks.find(risk => risk.severity === 'high')) return 'high'
      if (this.result.risks.length) return 'medium'
      return 'low'
    },
    primaryIntentLabel () {
      const intent = this.result && this.result.ideas && this.result.ideas[0]
      return intent ? (intent.label || intent.type.replace(/_/g, ' ')) : '아이디어 검토'
    }
  },
  methods: {
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
    classificationText (classification) {
      const labels = {
        engine_supported_idea: '엔진도 지지',
        high_risk: '위험한 시도',
        practical_but_risky: '실전적이나 위험',
        risky_practical_try: '위험한 실전 승부수',
        playable_alternative: '둘 만한 대안',
        needs_tactical_check: '전술 확인 필요',
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
  margin: 10px 0;
  padding: 10px;
  background: var(--second-bg-color);
  border: 1px solid var(--main-border-color);
  border-radius: 6px;
  color: var(--main-text-color);
  font-size: 12px;
  text-align: left;
}
.review-header {
  display: flex;
  justify-content: space-between;
  gap: 8px;
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
  padding: 8px;
  border-left: 4px solid #c72634;
  background: rgba(199, 38, 52, 0.15);
}
.review-result {
  margin-top: 10px;
}
.classification {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-weight: 700;
  text-transform: capitalize;
}
.classification span {
  margin-left: 6px;
  padding: 1px 5px;
  border-radius: 8px;
  background: rgba(114, 137, 218, 0.25);
  font-size: 10px;
}
.risk-badge.high { background: rgba(199, 38, 52, 0.35); color: #ffb3b3; }
.risk-badge.medium { background: rgba(242, 153, 74, 0.30); color: #ffd9a8; }
.risk-badge.low { background: rgba(75, 181, 113, 0.25); color: #bff0cf; }
.intent-badge { background: rgba(114, 137, 218, 0.25); }
.cache-badge { background: rgba(127, 127, 127, 0.25); }
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
.danger h4 {
  color: #e06c75;
}
.review-empty {
  margin-top: 10px;
  line-height: 1.4;
}
</style>
