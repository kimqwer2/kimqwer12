<template>
  <details v-if="cfg.futureExplorerEnabled" class="future-explorer panel">
    <summary class="future-summary">
      <span>Engine Future Explorer</span>
      <small>{{ totalPositions }} positions · depth {{ cfg.futureExplorerStartDepth || 20 }}+ / move {{ cfg.futureExplorerStartMove || 15 }}+</small>
    </summary>

    <div class="future-toolbar">
      <span>Sort</span>
      <select v-model="sortMode">
        <option value="depth">Depth</option>
        <option value="appearances">Frequency</option>
      </select>
    </div>

    <p v-if="openings.length === 0" class="empty">Collected future positions will be grouped by starting setup here.</p>

    <details v-for="opening in openings" :key="opening.key" class="opening-group">
      <summary>
        <span>{{ opening.label }}</span>
        <small>{{ opening.positionCount }} positions · {{ opening.groups.length }} moves</small>
      </summary>

      <details v-for="group in opening.groups" :key="`${opening.key}-${group.moveNumber}`" class="move-group">
        <summary>
          <span>Move {{ group.moveNumber }}</span>
          <small>{{ group.items.length }} positions</small>
        </summary>

        <div class="move-actions">
          <button type="button" @click="toggleFull(group.id)">{{ isFull(group.id) ? 'Collapse All' : 'Expand All' }}</button>
          <button type="button" @click="toggleMeta(group.id)">{{ isMeta(group.id) ? 'Hide Details' : 'Details' }}</button>
        </div>

        <div class="chip-list">
          <button
            v-for="item in group.items"
            :key="item.key"
            type="button"
            class="future-chip"
            :title="sequenceTitle(item)"
            @mouseenter="preview(item)"
            @mouseleave="clearPreview"
            @click="jump(item)"
            @dblclick.stop="analyze(item)"
          >
            {{ chipLabel(item) }}
          </button>
        </div>

        <div v-if="isMeta(group.id)" class="meta-grid">
          <div v-for="item in group.items" :key="`meta-${item.key}`" class="meta-card">
            <b>{{ chipLabel(item) }}</b>
            <span>{{ score(item) }} · rank {{ rank(item) }} · seen {{ item.firstDepth }}–{{ item.lastDepth }}</span>
          </div>
        </div>

        <div v-if="isFull(group.id)" class="full-list">
          <article v-for="item in group.items" :key="`full-${item.key}`" class="full-card">
            <div class="full-head">
              <b>{{ chipLabel(item) }}</b>
              <span>{{ score(item) }} · rank {{ rank(item) }} · {{ item.appearances }}×</span>
            </div>
            <div class="sequence"><span>Reached by</span> {{ item.pvUCI || '—' }}</div>
            <div v-if="item.continuationUCI" class="sequence"><span>Then</span> {{ item.continuationUCI }}</div>
          </article>
        </div>
      </details>
    </details>
  </details>
</template>

<script>
import { mapGetters } from 'vuex'

export default {
  name: 'FutureExplorerPanel',
  data () {
    return {
      fullGroups: {},
      metaGroups: {}
    }
  },
  computed: {
    ...mapGetters(['futureExplorer', 'analysisVisualization']),
    cfg () { return this.analysisVisualization || {} },
    sortMode: {
      get () { return this.cfg.futureExplorerSortMode || 'depth' },
      set (value) { this.$store.dispatch('analysisVisualization', { futureExplorerSortMode: value }) }
    },
    openings () {
      const source = (this.futureExplorer && this.futureExplorer.openings) || {}
      const legacyGroups = (this.futureExplorer && this.futureExplorer.groups) || {}
      const openings = Object.keys(source).map(key => this.normalizeOpening(source[key], key))
      if (!openings.length && Object.keys(legacyGroups).length) {
        openings.push(this.normalizeOpening({ key: 'current', label: 'Current start', groups: legacyGroups }, 'current'))
      }
      return openings.filter(Boolean).sort((a, b) => a.label.localeCompare(b.label))
    },
    totalPositions () {
      return this.openings.reduce((sum, opening) => sum + opening.positionCount, 0)
    }
  },
  methods: {
    normalizeOpening (opening, key) {
      const groups = opening && opening.groups ? opening.groups : {}
      const normalizedGroups = Object.keys(groups).map(moveNumber => {
        const items = Object.values(groups[moveNumber] || {})
        const byAppearances = this.sortMode === 'appearances'
        items.sort((a, b) => byAppearances
          ? ((b.appearances || 0) - (a.appearances || 0)) || ((b.deepestDepth || 0) - (a.deepestDepth || 0))
          : ((b.deepestDepth || 0) - (a.deepestDepth || 0)) || ((b.appearances || 0) - (a.appearances || 0)))
        return { id: `${key}:${moveNumber}`, moveNumber, items }
      }).sort((a, b) => Number(a.moveNumber) - Number(b.moveNumber))
      return {
        key,
        label: (opening && opening.label) || 'Current start',
        groups: normalizedGroups,
        positionCount: normalizedGroups.reduce((sum, group) => sum + group.items.length, 0)
      }
    },
    isFull (id) { return Boolean(this.fullGroups[id]) },
    isMeta (id) { return Boolean(this.metaGroups[id]) },
    toggleFull (id) { this.$set(this.fullGroups, id, !this.fullGroups[id]) },
    toggleMeta (id) { this.$set(this.metaGroups, id, !this.metaGroups[id]) },
    chipLabel (item) {
      return this.sortMode === 'appearances' ? String(item.appearances || 0) : `D${item.deepestDepth || item.depth || 0}`
    },
    sequenceTitle (item) {
      const reached = item.pvUCI ? `Reached by: ${item.pvUCI}` : 'Reached by: —'
      const then = item.continuationUCI ? `\nThen: ${item.continuationUCI}` : ''
      return `${reached}${then}\nClick: jump · Double-click: deeper analysis`
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
.future-explorer { padding: 0.55rem 0.75rem; max-height: 28rem; overflow: auto; }
.future-summary, .opening-group > summary, .move-group > summary { cursor: pointer; display: flex; justify-content: space-between; gap: 0.5rem; align-items: center; }
.future-summary span { font-weight: 700; }
summary small { opacity: 0.65; font-size: 0.75rem; }
.future-toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 0.4rem; margin: 0.55rem 0; font-size: 0.8rem; }
.empty { opacity: 0.75; font-size: 0.85rem; }
.opening-group { margin-top: 0.45rem; padding-top: 0.35rem; border-top: 1px solid rgba(128,128,128,0.18); }
.move-group { margin: 0.35rem 0 0.35rem 0.55rem; }
.move-actions { display: flex; gap: 0.35rem; margin: 0.35rem 0; }
.move-actions button { font-size: 0.75rem; padding: 0.15rem 0.35rem; }
.chip-list { display: flex; flex-wrap: wrap; gap: 0.25rem; margin: 0.3rem 0; }
.future-chip { min-width: 2.25rem; padding: 0.16rem 0.38rem; border: 1px solid rgba(128,128,128,0.32); border-radius: 999px; background: rgba(128,128,128,0.10); color: inherit; font-size: 0.78rem; line-height: 1.2; cursor: pointer; }
.future-chip:hover { background: rgba(128,128,128,0.24); transform: translateY(-1px); }
.meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: 0.3rem; margin-top: 0.35rem; }
.meta-card, .full-card { border: 1px solid rgba(128,128,128,0.2); border-radius: 6px; background: rgba(128,128,128,0.07); padding: 0.35rem; }
.meta-card { display: flex; flex-direction: column; gap: 0.12rem; font-size: 0.75rem; }
.meta-card span { opacity: 0.75; }
.full-list { display: flex; flex-direction: column; gap: 0.35rem; margin-top: 0.35rem; }
.full-head { display: flex; justify-content: space-between; gap: 0.5rem; font-size: 0.82rem; }
.sequence { margin-top: 0.2rem; font-family: monospace; font-size: 0.76rem; white-space: normal; word-break: break-word; }
.sequence span { font-family: inherit; opacity: 0.6; margin-right: 0.3rem; }
</style>
