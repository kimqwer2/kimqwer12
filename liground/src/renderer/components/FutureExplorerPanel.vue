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
        <label class="quality-toggle"><input v-model="qualityMode" type="checkbox"> Quality</label>
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
        <button
          v-if="editingOpeningKey !== opening.key"
          type="button"
          class="rename-opening danger"
          @click.prevent.stop="deleteOpening(opening)"
        >Delete</button>
        <template v-else>
          <button type="button" class="rename-opening" @click.prevent.stop="saveOpeningName(opening)">Save</button>
          <button type="button" class="rename-opening" @click.prevent.stop="cancelOpeningName">Cancel</button>
        </template>
      </summary>
      <div v-for="group in opening.moveGroups" :key="group.moveNumber" class="move-group">
        <div class="move-heading">Move {{ group.moveNumber }} <span>({{ group.totalItems }})</span></div>
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
              <template v-if="entryMode(item) || qualityMode">
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
      <section class="piece-activity">
        <button type="button" class="piece-activity-summary" :aria-expanded="pieceActivityExpanded(opening.key) ? 'true' : 'false'" @click="togglePieceActivity(opening)">
          <span class="piece-activity-caret">{{ pieceActivityExpanded(opening.key) ? '▼' : '▶' }}</span>
          <span>Piece Activity</span>
          <small>({{ opening.positionCount }} positions)</small>
        </button>
        <div v-if="pieceActivityExpanded(opening.key)" class="piece-activity-panel">
          <div v-if="pieceActivityLoading[opening.key]" class="piece-activity-loading">Calculating piece activity…</div>
          <div v-else-if="pieceActivityFor(opening)" class="piece-activity-body">
            <p class="piece-activity-note">목적지는 각 기물이 이 오프닝 포지션들에서 처음 이동한 보드 좌표입니다.</p>
            <button type="button" class="piece-scan-button" @click="scanPieceActivity(opening)">Rescan Positions</button>
            <div v-if="pieceActivityEmpty(opening)" class="piece-activity-empty">No piece activity data could be generated for this Opening.</div>
            <div v-if="pieceActivityDiagnostics(opening)" class="piece-diagnostics">
              <strong>Scanned Opening</strong>
              <span>Expected positions: {{ pieceActivityDiagnostics(opening).expectedPositions }}</span>
              <span>Visited positions: {{ pieceActivityDiagnostics(opening).visitedPositions }}</span>
              <span>PVs found: {{ pieceActivityDiagnostics(opening).pvsFound }}</span>
              <span>Moves extracted: {{ pieceActivityDiagnostics(opening).movesExtracted }}</span>
              <span>Pieces detected: Cho {{ pieceActivityDiagnostics(opening).choPieces }} / Han {{ pieceActivityDiagnostics(opening).hanPieces }}</span>
              <span>Individual pieces matched: {{ pieceActivityDiagnostics(opening).piecesMatched }}</span>
              <span>Statistics generated: {{ pieceActivityDiagnostics(opening).statisticsGenerated }}</span>
            </div>
            <div v-if="!pieceActivityEmpty(opening)" class="piece-tabs" role="tablist" aria-label="Piece activity side">
              <button type="button" :class="{ active: pieceActivitySide(opening.key) === 'cho' }" @click="setPieceActivitySide(opening.key, 'cho')">Cho</button>
              <button type="button" :class="{ active: pieceActivitySide(opening.key) === 'han' }" @click="setPieceActivitySide(opening.key, 'han')">Han</button>
            </div>
            <div v-if="!pieceActivityEmpty(opening)" class="piece-activity-grid">
              <article
                v-for="piece in pieceActivityPieces(opening)"
                :key="piece.id"
                class="piece-card"
                :title="`시작 위치 ${piece.displaySquare}`"
                @mouseenter="highlightPieceStart(piece)"
                @mouseleave="clearPieceStartHighlight"
              >
                <h4>{{ piece.label }}</h4>
                <dl>
                  <div><dt>시작</dt><dd>{{ piece.displaySquare }}</dd></div>
                  <div><dt>이동률</dt><dd>{{ piece.moveRate }}%</dd><dd class="rate-count">{{ piece.moved }} / {{ piece.total }}</dd></div>
                  <div><dt>평균 첫 수</dt><dd>{{ piece.averageFirstMove }}</dd></div>
                </dl>
                <div class="top-moves">
                  <strong>첫 이동 목적지</strong>
                  <p v-if="!piece.topMoves.length" class="muted">No first moves</p>
                  <div v-for="move in piece.topMoves" :key="move.destination" class="top-move-row">
                    <code>{{ move.destination }}</code><span>{{ move.percent }}%</span>
                  </div>
                </div>
              </article>
            </div>
          </div>
        </div>
      </section>
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
    editingOpeningName: '',
    pieceActivityCache: {},
    pieceActivityLoading: {},
    pieceActivitySides: {},
    expandedPieceActivity: {},
    pieceActivityTimers: {}
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
    qualityMode: {
      get () { return !!this.cfg.futureExplorerQualityMode },
      set (value) { this.$store.dispatch('analysisVisualization', { futureExplorerQualityMode: !!value }) }
    },
    openings () {
      const explorer = this.futureExplorer || {}
      const openings = explorer.openings && Object.keys(explorer.openings).length
        ? explorer.openings
        : { [explorer.rootKey || 'current']: { rootKey: explorer.rootKey || 'current', rootFen: explorer.rootFen, groups: explorer.groups || {} } }
      return Object.keys(openings).map(openingKey => this.openingGroup(openingKey, openings[openingKey]))
        .filter(Boolean)
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
    pieceActivityExpanded (openingKey) {
      return !!this.expandedPieceActivity[openingKey]
    },
    togglePieceActivity (opening) {
      if (!opening || !opening.key) return
      const nextOpen = !this.pieceActivityExpanded(opening.key)
      this.$set(this.expandedPieceActivity, opening.key, nextOpen)
      if (nextOpen) this.ensurePieceActivity(opening)
      else this.clearPieceStartHighlight()
    },
    scanPieceActivity (opening) {
      this.ensurePieceActivity(opening, true)
    },
    ensurePieceActivity (opening, force = false) {
      if (!opening || !opening.key) return
      const signature = this.openingActivitySignature(opening)
      const cached = this.pieceActivityCache[opening.key]
      if (!force && cached && cached.signature === signature) return
      if (this.pieceActivityTimers[opening.key]) clearTimeout(this.pieceActivityTimers[opening.key])
      this.$set(this.pieceActivityLoading, opening.key, true)
      const timer = setTimeout(() => {
        const activity = this.calculatePieceActivity(opening, signature)
        this.$set(this.pieceActivityCache, opening.key, activity)
        this.$set(this.pieceActivityLoading, opening.key, false)
        this.$delete(this.pieceActivityTimers, opening.key)
      }, 0)
      this.$set(this.pieceActivityTimers, opening.key, timer)
    },
    pieceActivityFor (opening) {
      if (!opening || !opening.key) return null
      const cached = this.pieceActivityCache[opening.key]
      return cached && cached.signature === this.openingActivitySignature(opening) ? cached : null
    },
    pieceActivitySide (openingKey) {
      return this.pieceActivitySides[openingKey] || 'cho'
    },
    setPieceActivitySide (openingKey, side) {
      this.$set(this.pieceActivitySides, openingKey, side)
    },
    pieceActivityPieces (opening) {
      const activity = this.pieceActivityFor(opening)
      return activity ? activity[this.pieceActivitySide(opening.key)] || [] : []
    },
    pieceActivityDiagnostics (opening) {
      const activity = this.pieceActivityFor(opening)
      return activity ? activity.diagnostics : null
    },
    pieceActivityEmpty (opening) {
      const activity = this.pieceActivityFor(opening)
      return !!(activity && activity.diagnostics && activity.diagnostics.statisticsGenerated === 0)
    },
    calculatePieceActivity (opening, signature = this.openingActivitySignature(opening)) {
      const pieces = this.initialPieces(opening.rootFen)
      const byId = pieces.reduce((acc, piece) => {
        acc[piece.id] = { ...piece, moved: 0, firstMoveTotal: 0, destinations: {} }
        return acc
      }, {})
      const sourcePositions = opening.allItems || []
      const positions = sourcePositions.filter(item => item && item.pvUCI)
      const diagnostics = {
        expectedPositions: opening.positionCount || sourcePositions.length || 0,
        visitedPositions: sourcePositions.length,
        pvsFound: positions.length,
        movesExtracted: 0,
        choPieces: pieces.filter(piece => piece.side === 'cho').length,
        hanPieces: pieces.filter(piece => piece.side === 'han').length,
        piecesMatched: 0,
        statisticsGenerated: 0,
        scopeKey: opening.key || ''
      }
      positions.forEach(item => {
        const firstMoves = this.firstMovesByPiece(opening.rootFen, item.pvUCI)
        diagnostics.movesExtracted += String(item.pvUCI || '').split(/\s+/).filter(Boolean).length
        Object.keys(firstMoves).forEach(id => {
          if (!byId[id]) return
          const first = firstMoves[id]
          byId[id].moved += 1
          byId[id].firstMoveTotal += first.ply
          byId[id].destinations[first.to] = (byId[id].destinations[first.to] || 0) + 1
          diagnostics.piecesMatched += 1
        })
      })
      const total = Math.max(1, positions.length)
      const activity = ['cho', 'han'].reduce((acc, side) => {
        acc[side] = Object.values(byId)
          .filter(piece => piece.side === side)
          .sort((a, b) => a.order - b.order)
          .map(piece => this.pieceActivitySummary(piece, total))
        diagnostics.statisticsGenerated += acc[side].length
        return acc
      }, { cho: [], han: [] })
      activity.signature = signature
      activity.positionCount = positions.length
      activity.diagnostics = diagnostics
      return activity
    },
    pieceActivitySummary (piece, total) {
      const moved = piece.moved || 0
      const topMoves = Object.entries(piece.destinations || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([destination, count]) => ({ destination: this.displaySquare(destination), percent: Math.round((count / Math.max(1, moved)) * 100) }))
      return {
        id: piece.id,
        label: piece.label,
        square: piece.square,
        displaySquare: this.displaySquare(piece.square),
        moved,
        total,
        moveRate: ((moved / total) * 100).toFixed(1),
        averageFirstMove: moved ? (piece.firstMoveTotal / moved).toFixed(1) : '—',
        topMoves
      }
    },
    initialPieces (fen) {
      const board = this.parseFenBoard(fen)
      const rawPieces = board.flatMap((row, rank) => row
        .map((piece, file) => ({ piece, file, rank, square: this.squareName(file, rank, board.length) }))
        .filter(item => item.piece))
      const sidePieces = { cho: rawPieces.filter(item => item.piece === item.piece.toUpperCase()), han: rawPieces.filter(item => item.piece !== item.piece.toUpperCase()) }
      return ['cho', 'han'].flatMap(side => this.nameStartingPieces(sidePieces[side], side, board.length))
    },
    nameStartingPieces (pieces, side, height) {
      const backRank = side === 'cho'
        ? Math.max(...pieces.map(piece => piece.rank), 0)
        : Math.min(...pieces.map(piece => piece.rank), height - 1)
      const typeOrder = { Pawn: 0, Cannon: 1, Chariot: 2, Horse: 3, Elephant: 4, Advisor: 5, King: 6 }
      const byType = pieces.reduce((acc, piece) => {
        const type = this.pieceTypeName(piece.piece)
        if (!acc[type]) acc[type] = []
        acc[type].push(piece)
        return acc
      }, {})
      Object.values(byType).forEach(list => list.sort((a, b) => a.file - b.file || a.rank - b.rank))
      return pieces.map(piece => {
        const type = this.pieceTypeName(piece.piece)
        const typed = byType[type] || []
        const typeIndex = typed.findIndex(item => item.square === piece.square)
        const sidePrefix = side === 'cho' ? '초' : '한'
        const koreanType = this.pieceTypeKorean(type)
        const sideMarker = typed.length === 2 ? (typeIndex === 0 ? '좌' : '우') : ''
        const label = type === 'Pawn'
          ? `${sidePrefix} ${koreanType}${typeIndex + 1}`
          : `${sidePrefix} ${sideMarker}${koreanType}`
        const rankGroup = Object.prototype.hasOwnProperty.call(typeOrder, type) ? typeOrder[type] : 9
        const homeOffset = Math.abs(piece.rank - backRank)
        return {
          id: `${side}:${piece.square}:${piece.piece}`,
          side,
          square: piece.square,
          label,
          order: (rankGroup * 100) + homeOffset + piece.file / 10
        }
      })
    },
    firstMovesByPiece (fen, pvUCI) {
      const board = this.parseFenBoard(fen)
      const occupancy = {}
      board.forEach((row, rank) => row.forEach((piece, file) => {
        if (piece) {
          const square = this.squareName(file, rank, board.length)
          occupancy[square] = `${piece === piece.toUpperCase() ? 'cho' : 'han'}:${square}:${piece}`
        }
      }))
      const first = {}
      String(pvUCI || '').split(/\s+/).filter(Boolean).forEach((move, idx) => {
        const parsed = this.moveSquares(move, occupancy)
        if (!parsed) return
        const { from, to } = parsed
        const id = occupancy[from]
        if (!id) return
        if (!first[id]) first[id] = { ply: idx + 1, to }
        delete occupancy[from]
        occupancy[to] = id
      })
      return first
    },
    parseFenBoard (fen) {
      const placement = String(fen || '').split(/\s+/)[0] || ''
      return placement.split('/').map(row => {
        const cells = []
        for (const ch of row) {
          if (/\d/.test(ch)) for (let i = 0; i < Number(ch); i++) cells.push('')
          else cells.push(ch)
        }
        return cells
      })
    },
    squareName (file, rank, height = 10) {
      return `${String.fromCharCode(97 + file)}${height - rank}`
    },
    moveSquares (move, occupancy = {}) {
      const parts = String(move || '').match(/^([a-z])(\d+)([a-z])(\d+)/i)
      if (!parts) return null
      const rawFrom = `${parts[1].toLowerCase()}${Number(parts[2])}`
      const rawTo = `${parts[3].toLowerCase()}${Number(parts[4])}`
      if (occupancy[rawFrom]) return { from: rawFrom, to: rawTo }
      const shiftedFrom = this.shiftSquareRank(rawFrom, -1)
      if (occupancy[shiftedFrom]) return { from: shiftedFrom, to: this.shiftSquareRank(rawTo, -1) }
      return { from: rawFrom, to: rawTo }
    },
    shiftSquareRank (square, delta) {
      const match = String(square || '').match(/^([a-z])(\d+)$/i)
      if (!match) return square
      return `${match[1].toLowerCase()}${Math.max(0, Number(match[2]) + delta)}`
    },
    displaySquare (square) {
      const match = String(square || '').match(/^([a-z])(\d+)$/i)
      if (!match) return square || '—'
      return `${match[1].toUpperCase()}${Number(match[2])}`
    },
    pieceTypeKorean (type) {
      const names = { Pawn: '졸', Chariot: '차', Horse: '마', Elephant: '상', Advisor: '사', King: '궁', Cannon: '포' }
      return names[type] || type
    },
    pieceTypeName (piece) {
      const names = { p: 'Pawn', r: 'Chariot', n: 'Horse', h: 'Horse', b: 'Elephant', e: 'Elephant', a: 'Advisor', k: 'King', c: 'Cannon' }
      return names[String(piece || '').toLowerCase()] || String(piece || '').toUpperCase()
    },

    openingActivitySignature (opening) {
      if (!opening || !opening.key) return ''
      const groups = opening.moveGroups || []
      const parts = [opening.key, opening.rootFen || '', String(opening.positionCount || 0)]
      groups.forEach(group => {
        parts.push(String(group.moveNumber), String(group.totalItems || 0))
        ;(group.allItems || []).forEach(item => {
          parts.push([
            item.key || '',
            item.signature || '',
            item.pvUCI || '',
            item.appearances || 0,
            item.deepestDepth || 0,
            item.averageEval || ''
          ].join(':'))
        })
      })
      return parts.join('|')
    },
    highlightPieceStart (piece) {
      if (!piece || !piece.square) return
      this.$store.dispatch('previewFutureExplorerPieceStart', { square: piece.square, label: piece.label })
    },
    clearPieceStartHighlight () {
      this.$store.dispatch('clearFutureExplorerPieceStartPreview')
    },
    openingGroup (openingKey, opening) {
      const groups = (opening && opening.groups) || {}
      const fallbackLabel = this.openingLabel(opening && opening.rootFen)
      const openingLabel = (opening && (opening.name || opening.autoName)) || fallbackLabel
      const moveGroups = Object.keys(groups).map(moveNumber => {
        const items = Object.values(groups[moveNumber] || {}).map(item => ({ ...item, moveNumber, openingLabel }))
        const byAppearances = this.sortMode === 'appearances'
        const byEvaluation = this.sortMode === 'evaluation'
        items.sort((a, b) => {
          if (byEvaluation) {
            const depthOrder = (b.deepestDepth || 0) - (a.deepestDepth || 0)
            if (Math.abs(depthOrder) >= 3) return depthOrder
            const aEval = this.displayEvalValue(a)
            const bEval = this.displayEvalValue(b)
            const evalOrder = Number.isFinite(bEval) && Number.isFinite(aEval)
              ? bEval - aEval
              : (Number.isFinite(bEval) ? 1 : 0) - (Number.isFinite(aEval) ? 1 : 0)
            return depthOrder || evalOrder || ((b.appearances || 0) - (a.appearances || 0))
          }
          return byAppearances
            ? ((b.appearances || 0) - (a.appearances || 0)) || ((b.deepestDepth || 0) - (a.deepestDepth || 0))
            : ((b.deepestDepth || 0) - (a.deepestDepth || 0)) || ((b.appearances || 0) - (a.appearances || 0))
        })
        return { moveNumber, items: items.slice(0, 12), allItems: items, totalItems: items.length }
      }).sort((a, b) => Number(a.moveNumber) - Number(b.moveNumber))
      if (!moveGroups.length) return null
      return {
        key: openingKey,
        rootFen: opening && opening.rootFen,
        label: openingLabel,
        fallbackLabel,
        customName: opening && opening.name,
        autoName: opening && opening.autoName,
        moveGroups,
        positionCount: moveGroups.reduce((sum, group) => sum + group.totalItems, 0),
        allItems: moveGroups.flatMap(group => group.allItems)
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
    deleteOpening (opening) {
      if (!opening || !opening.key) return
      if (!confirm(`Delete Future Explorer section "${opening.label}"?`)) return
      this.$store.dispatch('deleteFutureExplorerOpening', { rootKey: opening.key })
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
      const parts = [`D${item.deepestDepth || '—'}`, this.score(item), `${item.appearances || 0}×`, `D${item.firstDepth || '—'}–${item.deepestDepth || '—'}`]
      if (this.qualityMode) parts.push(`Q:${this.qualityScore(item)}`)
      return parts.join(' · ')
    },
    qualityScore (item) {
      const depthSpan = Math.max(1, (item.deepestDepth || 0) - (item.firstDepth || item.deepestDepth || 0) + 1)
      const depthScore = Math.min(1, (item.deepestDepth || 0) / 30)
      const frequencyScore = Math.min(1, Math.log10((item.appearances || 0) + 1) / 2)
      const variance = item.evalSamples > 1 && typeof item.evalSquareTotal === 'number'
        ? Math.max(0, item.evalSquareTotal / item.evalSamples - Math.pow(item.averageEval || 0, 2))
        : 0
      const consistencyScore = 1 / (1 + Math.sqrt(variance) / 120)
      const convergenceScore = Math.min(1, (item.appearances || 0) / depthSpan)
      return (depthScore * 0.35 + consistencyScore * 0.3 + frequencyScore * 0.2 + convergenceScore * 0.15).toFixed(2)
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
    continuationName (item) {
      const base = item.openingLabel || 'Future Explorer'
      return `${base} · D${item.deepestDepth || '—'}`
    },
    analyze (item) {
      if (this.previewClearTimer) clearTimeout(this.previewClearTimer)
      this.previewClearTimer = null
      this.$store.dispatch('analyzeFuturePosition', { ...item, continuationName: this.continuationName(item) })
    }
  },
  beforeDestroy () {
    if (this.previewClearTimer) clearTimeout(this.previewClearTimer)
    Object.values(this.pieceActivityTimers || {}).forEach(timer => clearTimeout(timer))
    this.clearPieceStartHighlight()
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
.rename-opening.danger { color: #d66; border-color: rgba(190,70,70,0.35); }
.quality-toggle { display: inline-flex; align-items: center; gap: 0.15rem; font-size: 0.72rem; opacity: 0.8; }
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
.piece-activity { margin-top: 0.55rem; padding-top: 0.35rem; border-top: 1px solid rgba(128,128,128,0.14); }
.piece-activity-summary { display: inline-flex; align-items: center; gap: 0.28rem; border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; font-size: 0.84rem; font-weight: 700; opacity: 0.9; padding: 0; }
.piece-activity-summary small { opacity: 0.65; font-weight: 400; }
.piece-activity-caret { width: 1rem; opacity: 0.78; }
.piece-activity-panel { margin-top: 0.35rem; }
.piece-activity-loading, .muted, .piece-activity-note { opacity: 0.7; font-size: 0.78rem; }
.piece-activity-note { margin: 0 0 0.35rem; }
.piece-scan-button { border: 1px solid rgba(128,128,128,0.25); border-radius: 999px; background: rgba(128,128,128,0.06); color: inherit; cursor: pointer; font-size: 0.72rem; padding: 0.16rem 0.5rem; margin: 0 0 0.4rem; }
.piece-activity-empty { margin: 0.35rem 0; opacity: 0.85; font-size: 0.82rem; }
.piece-diagnostics { display: grid; gap: 0.1rem; margin: 0.35rem 0; padding: 0.4rem; border: 1px solid rgba(128,128,128,0.16); border-radius: 8px; background: rgba(128,128,128,0.04); font-size: 0.72rem; opacity: 0.82; }
.piece-activity-body { margin-top: 0.4rem; }
.piece-tabs { display: flex; gap: 0.25rem; margin-bottom: 0.4rem; }
.piece-tabs button { border: 1px solid rgba(128,128,128,0.25); border-radius: 999px; background: rgba(128,128,128,0.06); color: inherit; cursor: pointer; font-size: 0.76rem; padding: 0.18rem 0.55rem; }
.piece-tabs button.active { background: rgba(80,140,220,0.22); border-color: rgba(80,140,220,0.45); font-weight: 700; }
.piece-activity-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr)); gap: 0.4rem; }
.piece-card { border: 1px solid rgba(128,128,128,0.16); border-radius: 10px; background: rgba(128,128,128,0.04); padding: 0.45rem; }
.piece-card h4 { margin: 0 0 0.35rem; font-size: 0.84rem; }
.piece-card dl { display: grid; grid-template-columns: 1fr 1fr; gap: 0.35rem; margin: 0 0 0.35rem; }
.piece-card dt { font-size: 0.68rem; opacity: 0.68; }
.piece-card dd { margin: 0; font-size: 0.88rem; font-weight: 700; }
.piece-card dd.rate-count { grid-column: 1 / -1; font-size: 0.68rem; font-weight: 400; opacity: 0.72; }
.top-moves strong { display: block; margin-bottom: 0.15rem; font-size: 0.7rem; opacity: 0.78; }
.top-move-row { display: flex; justify-content: space-between; gap: 0.35rem; font-size: 0.74rem; }
.top-move-row code { font-family: monospace; }
</style>
