<template>
  <section v-if="cfg.futureExplorerEnabled" class="future-explorer panel">
    <div class="future-head">
      <div>
        <h4>Engine Future Explorer</h4>
        <small>UCI info PV changes are merged by reached position.</small>
      </div>
      <select v-model="sortMode" @change="saveSort">
        <option value="depth">Depth</option>
        <option value="appearances">Appearances</option>
      </select>
    </div>
    <p v-if="groups.length === 0" class="empty">Depth {{ cfg.futureExplorerStartDepth || 20 }}+, move {{ cfg.futureExplorerStartMove || 15 }}+ PVs will appear here.</p>
    <details v-for="group in groups" :key="group.moveNumber" open>
      <summary>{{ group.moveNumber }} ▼ <span>{{ group.items.length }} positions</span></summary>
      <button
        v-for="item in group.items"
        :key="item.key"
        type="button"
        class="future-row"
        @mouseenter="preview(item)"
        @mouseleave="clearPreview"
        @click="jump(item)"
        @dblclick.stop="analyze(item)"
      >
        <span class="main">D{{ item.deepestDepth }} · {{ score(item) }} · {{ item.appearances }}×</span>
        <span class="meta">rank {{ rank(item) }} · seen {{ item.firstDepth }}–{{ item.lastDepth }}</span>
        <span class="pv">{{ item.pvUCI }}</span>
      </button>
    </details>
  </section>
</template>

<script>
import { mapGetters } from 'vuex'

export default {
  name: 'FutureExplorerPanel',
  computed: {
    ...mapGetters(['futureExplorer', 'analysisVisualization']),
    cfg () { return this.analysisVisualization || {} },
    sortMode: {
      get () { return this.cfg.futureExplorerSortMode || 'depth' },
      set (value) { this.$store.dispatch('analysisVisualization', { futureExplorerSortMode: value }) }
    },
    groups () {
      const groups = (this.futureExplorer && this.futureExplorer.groups) || {}
      return Object.keys(groups).map(moveNumber => {
        const items = Object.values(groups[moveNumber] || {})
        const byAppearances = this.sortMode === 'appearances'
        items.sort((a, b) => byAppearances
          ? ((b.appearances || 0) - (a.appearances || 0)) || ((b.deepestDepth || 0) - (a.deepestDepth || 0))
          : ((b.deepestDepth || 0) - (a.deepestDepth || 0)) || ((b.appearances || 0) - (a.appearances || 0)))
        return { moveNumber, items: items.slice(0, 12) }
      }).sort((a, b) => Number(a.moveNumber) - Number(b.moveNumber))
    }
  },
  methods: {
    saveSort () {},
    score (item) {
      if (typeof item.mate === 'number') return `#${item.mate}`
      if (typeof item.averageEval === 'number') return (item.averageEval / 100).toFixed(2)
      return '—'
    },
    rank (item) {
      return typeof item.averageRank === 'number' ? item.averageRank.toFixed(1) : '—'
    },
    preview (item) { this.$store.dispatch('previewFuturePosition', item) },
    clearPreview () { this.$store.dispatch('clearFuturePreview') },
    jump (item) { this.$store.dispatch('jumpToFuturePosition', item) },
    analyze (item) { this.$store.dispatch('analyzeFuturePosition', item) }
  }
}
</script>

<style scoped>
.future-explorer { padding: 0.75rem; max-height: 28rem; overflow: auto; }
.future-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.future-head h4 { margin: 0; }
.empty { opacity: 0.75; font-size: 0.85rem; }
details { margin-top: 0.5rem; }
summary { cursor: pointer; font-weight: 600; }
summary span { opacity: 0.65; font-weight: 400; margin-left: 0.35rem; }
.future-row { display: block; width: 100%; margin: 0.25rem 0; padding: 0.45rem; text-align: left; border: 1px solid rgba(128,128,128,0.25); border-radius: 6px; background: rgba(128,128,128,0.08); color: inherit; cursor: pointer; }
.future-row:hover { background: rgba(128,128,128,0.18); }
.main, .meta, .pv { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.main { font-weight: 600; }
.meta { opacity: 0.7; font-size: 0.8rem; }
.pv { font-family: monospace; font-size: 0.78rem; margin-top: 0.15rem; }
</style>
