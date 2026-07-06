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
          <option value="appearances">Frequency</option>
          <option value="evaluation">Evaluation</option>
        </select>
        <select v-model="evalPerspective" title="Evaluation perspective">
          <option value="auto">Auto</option>
          <option value="cho">Cho</option>
          <option value="han">Han</option>
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
        <span v-if="editingOpeningKey !== opening.key" class="opening-title">{{ opening.label }}</span>
        <input
          v-else
          v-model="editingOpeningName"
          class="opening-name-input"
          type="text"
          @click.stop
          @keydown.enter.prevent="saveOpeningName(opening)"
          @keydown.esc.prevent="cancelOpeningName"
        >
        <span class="opening-meta">{{ opening.positionCount }} positions<span v-if="opening.customName"> · {{ opening.fallbackLabel }}</span></span>
        <button
          v-if="editingOpeningKey !== opening.key"
          type="button"
          class="rename-opening"
          @click.prevent.stop="startOpeningNameEdit(opening)"
        >Rename</button>
        <template v-else>
          <button type="button" class="rename-opening" @click.prevent.stop="saveOpeningName(opening)">Save</button>
          <button type="button" class="rename-opening" @click.prevent.stop="cancelOpeningName">Cancel</button>
        </template>
      </summary>
      <div v-for="group in opening.moveGroups" :key="group.moveNumber" class="move-group">
        <div class="move-heading">Move {{ group.moveNumber }} <span>({{ group.items.length }})</span></div>
        <div class="future-chip-row">
          <article v-for="item in group.items" :key="entryKey(item)" class="future-entry" :class="{ full: entryMode(item) === 'full' }">
            <button
              type="button"
              class="future-chip"
              :class="{ expanded: entryMode(item) }"
              :title="chipTitle(item)"
              @mouseenter="preview(item)"
              @mouseleave="clearPreview"
              @click="handleChipClick($event, item)"
              @dblclick.stop="analyze(item)"
            >
              <template v-if="entryMode(item)">
                <span>{{ compactSummary(item) }}</span>
              </template>
              <template v-else>
                <span class="main">D{{ item.deepestDepth }}</span>
                <span class="score">{{ score(item) }}</span>
                <span class="meta">{{ item.appearances }}×</span>
              </template>
            </button>
            <div v-if="entryMode(item) === 'full'" class="entry-lines">
              <p><strong>Reached by</strong> <code>{{ item.pvUCI || '—' }}</code></p>
              <p><strong>Continuation PV</strong> <code>{{ item.continuationUCI || '—' }}</code></p>
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
    previewClearTimer: null,
    editingOpeningKey: '',
    editingOpeningName: ''
  }),
  computed: {
    ...mapGetters(['futureExplorer', 'analysisVisualization']),
    cfg () { return this.analysisVisualization || {} },
    sortMode: {
      get () { return this.cfg.futureExplorerSortMode || 'depth' },
      set (value) { this.$store.dispatch('analysisVisualization', { futureExplorerSortMode: value }) }
    },
    evalPerspective: {
      get () { return this.cfg.futureExplorerEvalPerspective || 'auto' },
      set (value) { this.$store.dispatch('analysisVisualization', { futureExplorerEvalPerspective: value }) }
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
      const fallbackLabel = this.openingLabel(opening && opening.rootFen)
      const openingLabel = (opening && opening.name) || fallbackLabel
      const moveGroups = Object.keys(groups).map(moveNumber => {
        const items = Object.values(groups[moveNumber] || {}).map(item => ({ ...item, moveNumber }))
        const byAppearances = this.sortMode === 'appearances'
        const byEvaluation = this.sortMode === 'evaluation'
        items.sort((a, b) => {
          if (byEvaluation) {
            const aEval = this.displayEvalValue(a)
            const bEval = this.displayEvalValue(b)
            const evalOrder = Number.isFinite(bEval) && Number.isFinite(aEval)
              ? bEval - aEval
              : (Number.isFinite(bEval) ? 1 : 0) - (Number.isFinite(aEval) ? 1 : 0)
            return evalOrder || ((b.deepestDepth || 0) - (a.deepestDepth || 0)) || ((b.appearances || 0) - (a.appearances || 0))
          }
          return byAppearances
            ? ((b.appearances || 0) - (a.appearances || 0)) || ((b.deepestDepth || 0) - (a.deepestDepth || 0))
            : ((b.deepestDepth || 0) - (a.deepestDepth || 0)) || ((b.appearances || 0) - (a.appearances || 0))
        })
        return { moveNumber, items: items.slice(0, 12) }
      }).sort((a, b) => Number(a.moveNumber) - Number(b.moveNumber))
      if (!moveGroups.length) return null
      return {
        key: openingKey,
        label: openingLabel,
        fallbackLabel,
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
    startOpeningNameEdit (opening) {
      if (!opening || !opening.key) return
      this.editingOpeningKey = opening.key
      this.editingOpeningName = opening.customName || opening.label || ''
      this.$nextTick(() => {
        const input = this.$el && this.$el.querySelector('.opening-name-input')
        if (input) {
          input.focus()
          input.select()
        }
      })
    },
    saveOpeningName (opening) {
      if (!opening || !opening.key) return
      this.$store.dispatch('renameFutureExplorerOpening', {
        rootKey: opening.key,
        name: this.editingOpeningName.trim()
      })
      this.cancelOpeningName()
    },
    cancelOpeningName () {
      this.editingOpeningKey = ''
      this.editingOpeningName = ''
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
        `Score ${this.score(item)} (${this.evalPerspectiveLabel(item)})`,
        `Rank ${this.rank(item)}`,
        `Seen ${item.firstDepth}–${item.lastDepth}`,
        `Reached by: ${item.pvUCI}${continuation}`
      ].join('\n')
    },
    sideToMoveFromFen (fen) {
      return String(fen || '').split(/\s+/)[1] !== 'b'
    },
    rootTurn (item) {
      return typeof item.rootTurn === 'boolean' ? item.rootTurn : this.sideToMoveFromFen(item.rootFen)
    },
    moveTurn (item) {
      if (typeof item.moveTurn === 'boolean') return item.moveTurn
      if (item.fen) return !this.sideToMoveFromFen(item.fen)
      const rootTurn = this.rootTurn(item)
      const moveNumber = Number(item.moveNumber) || 1
      return moveNumber % 2 === 1 ? rootTurn : !rootTurn
    },
    displayEvalValue (item) {
      if (typeof item.averageEval !== 'number') return Number.NEGATIVE_INFINITY
      if (this.evalPerspective === 'cho') return item.averageEval
      if (this.evalPerspective === 'han') return -item.averageEval
      return this.moveTurn(item) === this.rootTurn(item) ? item.averageEval : -item.averageEval
    },
    evalPerspectiveLabel (item) {
      if (this.evalPerspective === 'cho') return 'Cho'
      if (this.evalPerspective === 'han') return 'Han'
      return this.moveTurn(item) ? 'Auto · Cho to move' : 'Auto · Han to move'
    },
    score (item) {
      const displayEval = this.displayEvalValue(item)
      if (typeof item.mate === 'number') {
        const mate = Number.isFinite(displayEval) && displayEval < 0 ? -Math.abs(item.mate) : Math.abs(item.mate)
        return `#${mate}`
      }
      if (Number.isFinite(displayEval)) {
        const value = displayEval / 100
        return `${value > 0 ? '+' : ''}${value.toFixed(2)}`
      }
      return '—'
    },
    averageEval (item) {
      const displayEval = this.displayEvalValue(item)
      if (!Number.isFinite(displayEval)) return '—'
      const value = displayEval / 100
      return `${value > 0 ? '+' : ''}${value.toFixed(2)}`
    },
    compactSummary (item) {
      return [`D${item.deepestDepth || '—'}`, this.score(item), `${item.appearances || 0}×`, `D${item.firstDepth || '—'}–${item.deepestDepth || '—'}`].join(' · ')
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
.opening-group > summary .opening-meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.opening-name-input { min-width: 10rem; max-width: 18rem; border: 1px solid rgba(128,128,128,0.35); border-radius: 4px; background: rgba(128,128,128,0.08); color: inherit; font: inherit; padding: 0.12rem 0.3rem; }
.rename-opening { border: 1px solid rgba(128,128,128,0.2); border-radius: 999px; background: transparent; color: inherit; cursor: pointer; font-size: 0.68rem; padding: 0.1rem 0.32rem; opacity: 0.72; }
.rename-opening:hover { opacity: 1; background: rgba(128,128,128,0.12); }
.move-group { margin-top: 0.35rem; }
.move-heading { opacity: 0.85; font-size: 0.82rem; font-weight: 700; margin: 0.25rem 0 0.15rem; }
.move-heading span { opacity: 0.65; font-weight: 400; }
.future-chip-row { display: flex; flex-wrap: wrap; gap: 0.25rem; }
.future-entry { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 0.15rem; max-width: min(100%, 28rem); }
.future-entry.full { padding: 0.2rem; border: 1px solid rgba(128,128,128,0.16); border-radius: 10px; background: rgba(128,128,128,0.04); }
.future-chip { display: inline-flex; align-items: center; gap: 0.25rem; max-width: 100%; padding: 0.28rem 0.45rem; text-align: left; border: 1px solid rgba(128,128,128,0.25); border-radius: 999px; background: rgba(128,128,128,0.08); color: inherit; cursor: pointer; font-size: 0.78rem; }
.future-chip.expanded { font-weight: 600; }
.future-chip:hover { background: rgba(128,128,128,0.18); }
.entry-lines { max-width: 100%; font-size: 0.76rem; }
.entry-lines p { margin: 0.08rem 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.entry-lines code { font-family: monospace; font-size: 0.76rem; }
.main, .score, .meta { display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.main { font-weight: 600; }
.score { max-width: 4rem; }
.meta { opacity: 0.7; }
</style>
