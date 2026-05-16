<template>
  <section class="review-panel panel">
    <div class="review-header">
      <div>
        <h3>Human Review</h3>
        <p>Coach-style idea review, separate from engine MultiPV.</p>
      </div>
      <button
        type="button"
        class="review-clear"
        :disabled="!review.currentResult && !review.error && !(review.sequence && review.sequence.active)"
        @click="clearReview"
      >
        Clear
      </button>
    </div>

    <div
      v-if="review.sequence && review.sequence.active"
      class="sequence-banner"
    >
      <strong>Review Mode Active</strong>
      <span>Temporary line: {{ review.sequence.line.length }} move{{ review.sequence.line.length === 1 ? '' : 's' }}</span>
      <small>The real game history is not being modified.</small>
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
        Start Sequence Review
      </button>
      <template v-else>
        <button
          type="button"
          class="review-primary"
          :disabled="review.loading || review.sequence.line.length === 0"
          @click="reviewCurrentSequence"
        >
          {{ review.loading ? 'Reviewing…' : 'Review Sequence' }}
        </button>
        <div class="review-row">
          <button
            type="button"
            :disabled="review.sequence.line.length === 0"
            @click="clearReviewSequence"
          >
            Clear temporary line
          </button>
          <button
            type="button"
            @click="cancelReviewSequence"
          >
            Exit review mode
          </button>
        </div>
      </template>
      <button
        type="button"
        class="review-secondary"
        :disabled="review.loading"
        @click="reviewCurrentMove"
      >
        Review selected move
      </button>
      <details class="manual-review">
        <summary>Manual UCI fallback</summary>
        <div class="custom-review">
          <input
            v-model.trim="customMove"
            type="text"
            placeholder="custom UCI move, e.g. e3e4"
            @keyup.enter="reviewCustomMove"
          >
          <button
            type="button"
            :disabled="review.loading || !customMove"
            @click="reviewCustomMove"
          >
            Review idea
          </button>
        </div>
        <div class="custom-review">
          <input
            v-model.trim="customLine"
            type="text"
            placeholder="short line, e.g. e3e4 e6e5"
            @keyup.enter="reviewLine"
          >
          <button
            type="button"
            :disabled="review.loading || !customLine"
            @click="reviewLine"
          >
            Review typed line
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
        <span v-if="result.cached" class="cache-badge">cached</span>
      </div>
      <p class="summary">
        {{ result.summary }}
      </p>

      <div class="review-grid">
        <div>
          <strong>Reviewed</strong>
          <span>{{ result.reviewedMove || '—' }}</span>
        </div>
        <div>
          <strong>Best candidate</strong>
          <span>{{ result.engineEvidence && result.engineEvidence.bestMove ? result.engineEvidence.bestMove : '—' }}</span>
        </div>
      </div>

      <div
        v-if="result.ideas && result.ideas.length"
        class="review-section"
      >
        <h4>Likely idea</h4>
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
        <h4>Risks</h4>
        <ul>
          <li
            v-for="risk in result.risks"
            :key="risk.id"
          >
            {{ risk.text }} <small>{{ risk.severity }} · {{ confidence(risk.confidence) }}</small>
          </li>
        </ul>
      </div>

      <div
        v-if="result.keyMoments && result.keyMoments.length"
        class="review-section"
      >
        <h4>Key moments</h4>
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
        <span><i class="legend-red" /> danger / punishment</span>
        <span><i class="legend-orange" /> attacking idea</span>
        <span><i class="legend-blue" /> sequence reply</span>
      </div>

      <div
        v-if="result.overlays && result.overlays.length"
        class="overlay-note"
      >
        {{ result.overlays.length }} review overlay{{ result.overlays.length === 1 ? '' : 's' }} shown on the board.
      </div>
    </div>

    <div
      v-else-if="!review.error"
      class="review-empty"
    >
      Start Sequence Review, play a temporary line directly on the board, then ask for coach-style feedback. You can also review the selected historical move.
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
      if (!this.result || !this.result.classification) return 'Review'
      return this.result.classification.replace(/_/g, ' ')
    },
    severityLabel () {
      if (!this.result) return 'Ready'
      if (this.result.risks && this.result.risks.find(risk => risk.severity === 'high')) return 'High risk'
      if (this.result.risks && this.result.risks.length) return 'Watch closely'
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
      return intent ? intent.type.replace(/_/g, ' ') : 'idea review'
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
      if (typeof value !== 'number') return 'confidence n/a'
      return `${Math.round(value * 100)}% confidence`
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
