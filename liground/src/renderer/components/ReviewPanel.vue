<template>
  <section class="review-panel panel">
    <div class="review-header">
      <div>
        <h3>Human Review</h3>
        <p>Review-layer explanations are kept separate from engine MultiPV.</p>
      </div>
      <button
        type="button"
        class="review-clear"
        :disabled="!review.currentResult && !review.error"
        @click="clearReview"
      >
        Clear
      </button>
    </div>

    <div class="review-actions">
      <button
        type="button"
        class="review-primary"
        :disabled="review.loading"
        @click="reviewCurrentMove"
      >
        {{ review.loading ? 'Reviewing…' : 'Review this move' }}
      </button>
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
          Review line
        </button>
      </div>
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
        {{ classificationLabel }}
        <span v-if="result.cached">cached</span>
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
      Select a move in the game history, then ask for a review. Phase 1 focuses on the end-to-end review pipeline and safe overlays.
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
    }
  },
  methods: {
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
.review-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
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
ul {
  margin: 4px 0 0 16px;
  padding: 0;
}
li + li {
  margin-top: 4px;
}
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
