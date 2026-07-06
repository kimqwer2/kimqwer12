<template>
  <details v-if="cfg.futureExplorerEnabled" class="future-explorer panel">
    <summary class="future-panel-summary">
      <span>Engine Future Explorer</span>
      <small>{{ totalPositions }} positions</small>
    </summary>
    <div class="future-head">
      <small>UCI info PV changes are merged by reached position.</small>
      <div class="future-controls">
        <button type="button" @click="setAllOpen(true)">Expand All</button>
        <button type="button" @click="setAllOpen(false)">Collapse All</button>
        <select v-model="sortMode" @change="saveSort">
          <option value="depth">Depth</option>
          <option value="appearances">Appearances</option>
        </select>
      </div>
    </div>
    <p v-if="openings.length === 0" class="empty">Depth {{ cfg.futureExplorerStartDepth || 20 }}+, move {{ cfg.futureExplorerStartMove || 15 }}+ PVs will appear here.</p>
    <details
      v-for="opening in openings"
      :key="opening.key"
      ref="openingDetails"
      class="opening-group"
    >
      <summary>{{ opening.label }} <span>{{ opening.positionCount }} positions</span></summary>
      <div v-for="group in opening.moveGroups" :key="group.moveNumber" class="move-group">
        <div class="move-heading">Move {{ group.moveNumber }} <span>({{ group.items.length }})</span></div>
        <div class="future-chip-row">
          <button
            v-for="item in group.items"
            :key="item.key"
            type="button"
            class="future-chip"
            :title="chipTitle(item)"
            @mouseenter="preview(item)"
            @mouseleave="clearPreview"
            @click="jump(item)"
            @dblclick.stop="analyze(item)"
          >
            <span class="main">D{{ item.deepestDepth }}</span>
            <span class="score">{{ score(item) }}</span>
            <span class="meta">{{ item.appearances }}×</span>
          </button>
        </div>
      </div>
    </details>
  </details>
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
    openings () {
      const groups = (this.futureExplorer && this.futureExplorer.groups) || {}
      const openingKey = (this.futureExplorer && this.futureExplorer.rootKey) || 'current'
      const openingLabel = this.openingLabel(this.futureExplorer && this.futureExplorer.rootFen)
      const moveGroups = Object.keys(groups).map(moveNumber => {
        const items = Object.values(groups[moveNumber] || {})
        const byAppearances = this.sortMode === 'appearances'
        items.sort((a, b) => byAppearances
          ? ((b.appearances || 0) - (a.appearances || 0)) || ((b.deepestDepth || 0) - (a.deepestDepth || 0))
          : ((b.deepestDepth || 0) - (a.deepestDepth || 0)) || ((b.appearances || 0) - (a.appearances || 0)))
        return { moveNumber, items: items.slice(0, 12) }
      }).sort((a, b) => Number(a.moveNumber) - Number(b.moveNumber))
      if (!moveGroups.length) return []
      return [{
        key: openingKey,
        label: openingLabel,
        moveGroups,
        positionCount: moveGroups.reduce((sum, group) => sum + group.items.length, 0)
      }]
    },
    totalPositions () {
      return this.openings.reduce((sum, opening) => sum + opening.positionCount, 0)
    }
  },
  methods: {
    saveSort () {},
    openingLabel (fen) {
      if (!fen) return 'Current opening'
      const parts = String(fen).split(/\s+/)
      return `Opening · ${parts.slice(0, 2).join(' ')}`
    },
    setAllOpen (open) {
      this.openingDetailRefs().forEach(el => { el.open = open })
    },
    openingDetailRefs () {
      const details = this.$refs.openingDetails || []
      return Array.isArray(details) ? details.filter(Boolean) : [details].filter(Boolean)
    },
    chipTitle (item) {
      const continuation = item.continuationUCI ? `\nThen: ${item.continuationUCI}` : ''
      return [
        `Depth ${item.deepestDepth}`,
        `Score ${this.score(item)}`,
        `Rank ${this.rank(item)}`,
        `Seen ${item.firstDepth}–${item.lastDepth}`,
        `Reached by: ${item.pvUCI}${continuation}`
      ].join('\n')
    },
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
.future-panel-summary { cursor: pointer; font-weight: 700; display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.future-panel-summary small { opacity: 0.65; font-weight: 400; }
.future-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-top: 0.5rem; }
.future-controls { display: flex; align-items: center; gap: 0.35rem; }
.future-controls button { border: 1px solid rgba(128,128,128,0.25); border-radius: 4px; background: rgba(128,128,128,0.08); color: inherit; cursor: pointer; font-size: 0.78rem; padding: 0.2rem 0.4rem; }
.empty { opacity: 0.75; font-size: 0.85rem; }
.opening-group { margin-top: 0.5rem; }
.opening-group > summary { cursor: pointer; font-weight: 600; }
.opening-group > summary span { opacity: 0.65; font-weight: 400; margin-left: 0.35rem; }
.move-group { margin-top: 0.35rem; }
.move-heading { opacity: 0.85; font-size: 0.82rem; font-weight: 700; margin: 0.25rem 0 0.15rem; }
.move-heading span { opacity: 0.65; font-weight: 400; }
.future-chip-row { display: flex; flex-wrap: wrap; gap: 0.25rem; }
.future-chip { display: inline-flex; align-items: center; gap: 0.25rem; max-width: 100%; padding: 0.28rem 0.45rem; text-align: left; border: 1px solid rgba(128,128,128,0.25); border-radius: 999px; background: rgba(128,128,128,0.08); color: inherit; cursor: pointer; font-size: 0.78rem; }
.future-chip:hover { background: rgba(128,128,128,0.18); }
.main, .score, .meta { display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.main { font-weight: 600; }
.score { max-width: 4rem; }
.meta { opacity: 0.7; }
</style>
