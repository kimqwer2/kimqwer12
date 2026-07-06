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
        <button type="button" @click="toggleAllEntryDetails('details')">Expand Details</button>
        <button type="button" @click="toggleAllEntryDetails('full')">Expand Full</button>
        <button type="button" class="danger" @click="clearExplorer">Clear Future Explorer</button>
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
      <summary class="opening-summary">
        <span class="opening-title">{{ opening.label }}</span>
        <span>{{ opening.positionCount }} positions</span>
        <button type="button" class="rename-opening" @click.prevent.stop="renameOpening(opening)">Rename</button>
      </summary>
      <div v-for="group in opening.moveGroups" :key="group.moveNumber" class="move-group">
        <div class="move-heading">Move {{ group.moveNumber }} <span>({{ group.items.length }})</span></div>
        <div class="future-chip-row">
          <article v-for="item in group.items" :key="entryKey(item)" class="future-entry" :class="{ expanded: entryMode(item) }">
            <button
              type="button"
              class="future-chip"
              :title="chipTitle(item)"
              @mouseenter="preview(item)"
              @mouseleave="clearPreview"
              @click="handleChipClick($event, item)"
              @dblclick.stop="analyze(item)"
            >
              <span class="main">D{{ item.deepestDepth }}</span>
              <span class="score">{{ score(item) }}</span>
              <span class="meta">{{ item.appearances }}×</span>
            </button>
            <div v-if="entryMode(item)" class="entry-detail">
              <div class="entry-summary">{{ compactSummary(item) }}</div>
              <div v-if="entryMode(item) === 'full'" class="entry-lines">
                <p><strong>Reached by</strong> <code>{{ item.pvUCI || '—' }}</code></p>
                <p><strong>Continuation PV</strong> <code>{{ item.continuationUCI || '—' }}</code></p>
              </div>
            </div>
          </article>
        </div>
      </div>
    </details>
  </details>
</template>

<script>
import { mapGetters } from 'vuex'

export default {
  name: 'FutureExplorerPanel',
  data: () => ({
    expandedEntries: {},
    previewClearTimer: null
  }),
  computed: {
    ...mapGetters(['futureExplorer', 'analysisVisualization']),
    cfg () { return this.analysisVisualization || {} },
    sortMode: {
      get () { return this.cfg.futureExplorerSortMode || 'depth' },
      set (value) { this.$store.dispatch('analysisVisualization', { futureExplorerSortMode: value }) }
    },
    openings () {
      const explorer = this.futureExplorer || {}
      const openings = explorer.openings && Object.keys(explorer.openings).length
        ? explorer.openings
        : { [explorer.rootKey || 'current']: { rootKey: explorer.rootKey || 'current', rootFen: explorer.rootFen, groups: explorer.groups || {} } }
      return Object.keys(openings).map(openingKey => this.openingGroup(openingKey, openings[openingKey]))
        .filter(Boolean)
        .sort((a, b) => a.label.localeCompare(b.label))
    },
    totalPositions () {
      return this.openings.reduce((sum, opening) => sum + opening.positionCount, 0)
    },
    allItems () {
      return this.openings.flatMap(opening => opening.moveGroups.flatMap(group => group.items))
    }
  },
  methods: {
    saveSort () {},
    openingGroup (openingKey, opening) {
      const groups = (opening && opening.groups) || {}
      const openingLabel = (opening && opening.name) || this.openingLabel(opening && opening.rootFen)
      const moveGroups = Object.keys(groups).map(moveNumber => {
        const items = Object.values(groups[moveNumber] || {}).map(item => ({ ...item, moveNumber }))
        const byAppearances = this.sortMode === 'appearances'
        items.sort((a, b) => byAppearances
          ? ((b.appearances || 0) - (a.appearances || 0)) || ((b.deepestDepth || 0) - (a.deepestDepth || 0))
          : ((b.deepestDepth || 0) - (a.deepestDepth || 0)) || ((b.appearances || 0) - (a.appearances || 0)))
        return { moveNumber, items: items.slice(0, 12) }
      }).sort((a, b) => Number(a.moveNumber) - Number(b.moveNumber))
      if (!moveGroups.length) return null
      return {
        key: openingKey,
        label: openingLabel,
        customName: opening && opening.name,
        moveGroups,
        positionCount: moveGroups.reduce((sum, group) => sum + group.items.length, 0)
      }
    },
    openingLabel (fen) {
      if (!fen) return 'Current opening'
      const parts = String(fen).split(/\s+/)
      return `Opening · ${parts.slice(0, 2).join(' ')}`
    },
    setAllOpen (open) {
      this.openingDetailRefs().forEach(el => { el.open = open })
    },
    setAllEntryDetails (mode) {
      const next = {}
      this.allItems.forEach(item => { next[this.entryKey(item)] = mode })
      this.expandedEntries = next
    },
    toggleAllEntryDetails (mode) {
      const items = this.allItems
      const allInMode = items.length > 0 && items.every(item => this.entryMode(item) === mode)
      if (allInMode) {
        this.expandedEntries = {}
        return
      }
      this.setAllEntryDetails(mode)
    },
    entryKey (item) {
      return `${item.moveNumber || ''}|${item.key || item.fen || item.pvUCI || ''}`
    },
    entryMode (item) {
      return this.expandedEntries[this.entryKey(item)] || ''
    },
    toggleEntryMode (item, mode) {
      const key = this.entryKey(item)
      const next = this.entryMode(item) === mode ? '' : mode
      this.$set(this.expandedEntries, key, next)
    },
    handleChipClick (event, item) {
      if (event && event.ctrlKey) {
        this.toggleEntryMode(item, 'full')
        return
      }
      this.jump(item)
    },
    renameOpening (opening) {
      if (!opening || !opening.key) return
      const nextName = prompt('Opening name', opening.customName || opening.label || '')
      if (nextName === null) return
      this.$store.dispatch('renameFutureExplorerOpening', {
        rootKey: opening.key,
        name: nextName.trim()
      })
    },
    clearExplorer () {
      if (!confirm('Clear all stored Future Explorer positions?')) return
      this.$store.dispatch('clearFutureExplorer')
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
    averageEval (item) {
      return typeof item.averageEval === 'number' ? (item.averageEval / 100).toFixed(2) : '—'
    },
    compactSummary (item) {
      return [`D${item.deepestDepth || '—'}`, this.score(item), `${item.appearances || 0}×`, `D${item.firstDepth || '—'}–D${item.lastDepth || item.deepestDepth || '—'}`].join(' · ')
    },
    rank (item) {
      return typeof item.averageRank === 'number' ? item.averageRank.toFixed(1) : '—'
    },
    preview (item) {
      if (this.previewClearTimer) clearTimeout(this.previewClearTimer)
      this.previewClearTimer = null
      this.$store.dispatch('previewFuturePosition', item)
    },
    clearPreview () {
      if (this.previewClearTimer) clearTimeout(this.previewClearTimer)
      this.previewClearTimer = setTimeout(() => {
        this.$store.dispatch('clearFuturePreview')
        this.previewClearTimer = null
      }, 400)
    },
    jump (item) {
      if (this.previewClearTimer) clearTimeout(this.previewClearTimer)
      this.previewClearTimer = null
      this.$store.dispatch('jumpToFuturePosition', item)
    },
    analyze (item) {
      if (this.previewClearTimer) clearTimeout(this.previewClearTimer)
      this.previewClearTimer = null
      this.$store.dispatch('analyzeFuturePosition', item)
    }
  },
  beforeDestroy () {
    if (this.previewClearTimer) clearTimeout(this.previewClearTimer)
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
.future-controls button.danger { border-color: rgba(190,70,70,0.35); color: #d66; }
.empty { opacity: 0.75; font-size: 0.85rem; }
.opening-group { margin-top: 0.5rem; }
.opening-group > summary { cursor: pointer; font-weight: 600; }
.opening-summary { display: flex; align-items: center; gap: 0.35rem; }
.opening-summary .opening-title { opacity: 1; font-weight: 600; margin-left: 0; }
.opening-group > summary span { opacity: 0.65; font-weight: 400; margin-left: 0.35rem; }
.rename-opening { border: 1px solid rgba(128,128,128,0.2); border-radius: 999px; background: transparent; color: inherit; cursor: pointer; font-size: 0.68rem; padding: 0.1rem 0.32rem; opacity: 0.72; }
.rename-opening:hover { opacity: 1; background: rgba(128,128,128,0.12); }
.move-group { margin-top: 0.35rem; }
.move-heading { opacity: 0.85; font-size: 0.82rem; font-weight: 700; margin: 0.25rem 0 0.15rem; }
.move-heading span { opacity: 0.65; font-weight: 400; }
.future-chip-row { display: flex; flex-wrap: wrap; gap: 0.25rem; }
.future-entry { display: inline-flex; align-items: center; gap: 0.2rem; max-width: 100%; }
.future-entry.expanded { display: block; width: 100%; margin: 0.15rem 0; padding: 0.35rem; border: 1px solid rgba(128,128,128,0.18); border-radius: 8px; background: rgba(128,128,128,0.05); }
.future-chip { display: inline-flex; align-items: center; gap: 0.25rem; max-width: 100%; padding: 0.28rem 0.45rem; text-align: left; border: 1px solid rgba(128,128,128,0.25); border-radius: 999px; background: rgba(128,128,128,0.08); color: inherit; cursor: pointer; font-size: 0.78rem; }
.future-chip:hover { background: rgba(128,128,128,0.18); }
.entry-detail { margin-top: 0.35rem; font-size: 0.78rem; }
.entry-summary { font-weight: 600; opacity: 0.9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.entry-lines { margin-top: 0.35rem; }
.entry-lines p { margin: 0.15rem 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.entry-lines code { font-family: monospace; font-size: 0.76rem; }
.main, .score, .meta { display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.main { font-weight: 600; }
.score { max-width: 4rem; }
.meta { opacity: 0.7; }
</style>
