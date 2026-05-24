<template>
  <div class="blue merida is2d">
    <div class="grid-parent">
      <div
        v-if="variant==='crazyhouse'|| variant==='shogi' "
        ref="pockets"
        class="pockets"
        :class="{ mirror : $store.getters.orientation === &quot;black&quot;, shogi: variant === &quot;shogi&quot; }"
      >
        <ChessPocket
          id="chesspocket_top"
          color="black"
          :pieces="piecesB"
          @selection="dropPiece"
        />
        <ChessPocket
          id="chesspocket_bottom"
          color="white"
          :pieces="piecesW"
          @selection="dropPiece"
        />
      </div>
      <div
        id="chessboard"
        :class="{ koth: variant==='kingofthehill', rk: variant==='racingkings', dim8x8: dimensionNumber===0, dim9x10: dimensionNumber === 3 , dim9x9: dimensionNumber === 1 }"
        :style="{ pointerEvents: boardPointerEvents }"
        @mousewheel.ctrl.prevent="resize($event)"
      >
        <div
          class="cg-board-wrap"
          @mousedown="closeCursorHand"
          @mouseup="openCursorHand"
        >
          <div
            class="resizer"
            @mouseover="shade"
            @mousedown="startDragging"
            @mouseout="hideShade"
          />
          <div ref="board" />
          <div
            v-if="isPromotionModalVisible"
            id="PromotionModal"
            ref="promotion"
            :style="promotionPosition"
          >
            <PromotionModal
              :prom-options="promotions"
              @close="closePromotionModal"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'
import { Chessground } from 'chessgroundx'
import * as cgUtil from 'chessgroundx/util'
import ChessPocket from './ChessPocket'
import PromotionModal from './PromotionModal.vue'

const WHITE = true
const BLACK = false

const BOARD_INTERACTION_MODES = Object.freeze({
  NORMAL_GAME: 'NORMAL_GAME',
  ANALYSIS: 'ANALYSIS',
  BOARD_EDITOR: 'BOARD_EDITOR',
  REVIEW_SEQUENCE: 'REVIEW_SEQUENCE',
  REVIEW_PREVIEW: 'REVIEW_PREVIEW'
})

const SAFE_SHAPE_BRUSHES = Object.freeze(['red', 'green', 'blue', 'yellow', 'paleBlue', 'paleGreen', 'paleRed'])

export default {
  name: 'ChessGround',
  components: {
    ChessPocket, PromotionModal
  },
  props: {
    free: {
      type: Boolean,
      default: false
    },
    onPromotion: {
      type: Function,
      default: () => 'q'
    },
    colors: {
      type: Array,
      default: () => (['w', 'b'])
    }
  },
  data () {
    return {
      boardWidth: 0,
      boardHeight: 0,
      startingPoint: 640,
      dragging: false,
      enlarged: 0,
      enlarged9x9width: 0,
      enlarged9x9height: 0,
      enlarged9x10width: 0,
      enlarged9x10height: 0,
      ranks: ['1', '2', '3', '4', '5', '6', '7', '8'],
      files: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      selectedPiece: null,
      piecesToIdx: {
        P: 4,
        N: 3,
        B: 2,
        R: 1,
        Q: 0,
        p: 0,
        n: 1,
        b: 2,
        r: 3,
        q: 4
      },
      shogiPiecesToIdx: {
        P: 6,
        L: 5,
        N: 4,
        S: 3,
        G: 2,
        B: 1,
        R: 0,
        p: 0,
        l: 1,
        n: 2,
        s: 3,
        g: 4,
        b: 5,
        r: 6
      },
      piecesW: [
        { count: 0, type: 'q-piece' },
        { count: 0, type: 'r-piece' },
        { count: 0, type: 'b-piece' },
        { count: 0, type: 'n-piece' },
        { count: 0, type: 'p-piece' }
      ],
      piecesB: [
        { count: 0, type: 'p-piece' },
        { count: 0, type: 'n-piece' },
        { count: 0, type: 'b-piece' },
        { count: 0, type: 'r-piece' },
        { count: 0, type: 'q-piece' }
      ],
      chessPiecesW: [
        { count: 0, type: 'q-piece' },
        { count: 0, type: 'r-piece' },
        { count: 0, type: 'b-piece' },
        { count: 0, type: 'n-piece' },
        { count: 0, type: 'p-piece' }
      ],
      chessPiecesB: [
        { count: 0, type: 'p-piece' },
        { count: 0, type: 'n-piece' },
        { count: 0, type: 'b-piece' },
        { count: 0, type: 'r-piece' },
        { count: 0, type: 'q-piece' }
      ],
      shogiPiecesB: [
        { count: 0, type: 'p-piece' },
        { count: 0, type: 'l-piece' },
        { count: 0, type: 'n-piece' },
        { count: 0, type: 's-piece' },
        { count: 0, type: 'g-piece' },
        { count: 0, type: 'b-piece' },
        { count: 0, type: 'r-piece' }
      ],
      shogiPiecesW: [
        { count: 0, type: 'r-piece' },
        { count: 0, type: 'b-piece' },
        { count: 0, type: 'g-piece' },
        { count: 0, type: 's-piece' },
        { count: 0, type: 'n-piece' },
        { count: 0, type: 'l-piece' },
        { count: 0, type: 'p-piece' }
      ],
      board: null,
      shapes: [],
      pieceShapes: [],
      promotions: [],
      isPromotionModalVisible: false,
      promotionMove: undefined,
      pieceStyleEl: null,
      boardStyleEl: null,
      boardSyncFrame: null,
      start: true
    }
  },
  computed: {
    currentMove () { // returns undefined when the current fen doesnt match a move from the history, otherwise it returns move from the moves array that matches the current fen
      for (let num = 0; num < this.moves.length; num++) {
        if (this.moves[num].fen === this.fen) {
          return this.moves[num]
        }
      }
      return undefined
    },
    turn () {
      return this.$store.getters.turn ? 'white' : 'black'
    },
    legalMoves () {
      return String(this.$store.getters.legalMoves || '').split(/\s+/).filter(Boolean)
    },
    boardInteractionMode () {
      if (this.reviewPreviewActive) return BOARD_INTERACTION_MODES.REVIEW_PREVIEW
      if (this.reviewSequenceActive) return BOARD_INTERACTION_MODES.REVIEW_SEQUENCE
      if (this.editorMode) return BOARD_INTERACTION_MODES.BOARD_EDITOR
      if (this.analysisMode) return BOARD_INTERACTION_MODES.ANALYSIS
      return BOARD_INTERACTION_MODES.NORMAL_GAME
    },
    boardStateSource () {
      const mode = this.boardInteractionMode
      if (mode === BOARD_INTERACTION_MODES.REVIEW_PREVIEW) {
        const preview = this.reviewPreview || {}
        const move = preview.move || {}
        return {
          mode,
          fen: preview.fen || (this.reviewSequenceActive ? this.reviewSequence.fen : this.fen),
          turnColor: move.side === 'opponent' ? 'white' : 'black',
          legalMoves: [],
          mutableHistory: false,
          movable: false,
          free: false,
          lastMove: move.move || null
        }
      }
      if (mode === BOARD_INTERACTION_MODES.REVIEW_SEQUENCE) {
        const sequence = this.reviewSequence || {}
        return {
          mode,
          fen: sequence.fen || this.fen,
          turnColor: sequence.turn ? 'white' : 'black',
          legalMoves: String(sequence.legalMoves || '').split(/\s+/).filter(Boolean),
          mutableHistory: false,
          movable: true,
          free: false,
          lastMove: sequence.lastMove || null
        }
      }
      if (mode === BOARD_INTERACTION_MODES.BOARD_EDITOR) {
        return {
          mode,
          fen: this.fen,
          turnColor: this.turn,
          legalMoves: [],
          mutableHistory: false,
          movable: true,
          free: true,
          lastMove: this.currentMove && this.currentMove.uci
        }
      }
      const canMoveOnShownFen = this.fen === this.lastFen || mode === BOARD_INTERACTION_MODES.ANALYSIS
      return {
        mode,
        fen: this.fen,
        turnColor: this.turn,
        legalMoves: this.legalMoves,
        mutableHistory: true,
        movable: canMoveOnShownFen,
        free: false,
        lastMove: this.currentMove && this.currentMove.uci
      }
    },
    promotionPosition () {
      if (this.promotionMove) {
        const dest = this.promotionMove.substring(2, 4)

        let left = (8 - cgUtil.key2pos(dest)[0]) * 12.5

        if (this.orientation === 'white') {
          left = 87.5 - left
        }

        const vertical = this.turn === this.orientation ? 0 : (8 - this.promotions.length) * 12.5
        return { left: `${left}%`, top: `${vertical}%` }
      } else {
        return undefined
      }
    },
    isPlayerTurn () {
      if (this.boardInteractionMode === BOARD_INTERACTION_MODES.REVIEW_PREVIEW || this.boardInteractionMode === BOARD_INTERACTION_MODES.REVIEW_SEQUENCE || this.boardInteractionMode === BOARD_INTERACTION_MODES.BOARD_EDITOR || this.boardInteractionMode === BOARD_INTERACTION_MODES.ANALYSIS) {
        return true
      }
      // In PvE: allow moves only when it's the player's turn
      if (this.PvE) {
        const playerCanMove = (this.turn === 'white') === this.PvEPlayerIsWhite
        return playerCanMove
      }
      // In EvE: never allow player moves (both sides are engines)
      if (this.EvE) {
        return false
      }
      // In PvP or analysis mode: always allow moves
      return true
    },
    boardPointerEvents () {
      // Block mouse input completely when not player's turn
      return this.isPlayerTurn ? 'auto' : 'none'
    },
    ...mapGetters(['initialized', 'variant', 'multipv', 'hoveredpv', 'redraw', 'pieceStyle', 'boardStyle', 'fen', 'lastFen', 'orientation', 'moves', 'isPast', 'dimensionNumber', 'analysisMode', 'editorMode', 'analysisVisualization', 'reviewSequence', 'reviewSequenceActive', 'reviewPreview', 'reviewPreviewActive', 'reviewOverlays', 'active', 'PvE', 'PvEPlayerIsWhite', 'EvE', 'enginetime', 'resized', 'resized9x9width', 'resized9x9height', 'resized9x10width', 'resized9x10height', 'dimNumber'])
  },
  watch: {
    dimensionNumber () {
      const boardSize = document.querySelector('.cg-wrap')
      switch (this.dimensionNumber) {
        case 0:
          boardSize.style.width = 600 + this.enlarged + 'px'
          boardSize.style.height = 600 + this.enlarged + 'px'
          this.startingPoint = this.enlarged
          document.body.dispatchEvent(new Event('chessground.resize'))
          break
        case 1:
          boardSize.style.width = 520 + this.enlarged9x9width + 'px'
          boardSize.style.height = 600 + this.enlarged9x9height + 'px'
          this.startingPoint = this.enlarged9x9height
          document.body.dispatchEvent(new Event('chessground.resize'))
          break
        case 3:
          boardSize.style.width = 540 + this.enlarged9x10width + 'px'
          boardSize.style.height = 600 + this.enlarged9x10height + 'px'
          this.startingPoint = this.enlarged9x10height
          document.body.dispatchEvent(new Event('chessground.resize'))
          break
      }
      this.boardWidth = boardSize.style.width
      this.boardHeight = boardSize.style.height
      this.$store.dispatch('setResized', this.enlarged)
      this.$store.dispatch('setResized9x9width', this.enlarged9x9width)
      this.$store.dispatch('setResized9x10width', this.enlarged9x10width)
      this.$store.dispatch('setResized9x9height', this.enlarged9x9height)
      this.$store.dispatch('setResized9x10height', this.enlarged9x10height)
      this.$store.dispatch('setDimNumber', this.dimensionNumber)
    },
    initialized () {
      this.updateBoard()
      this.renderAnalysisVisualization()
    },
    fen () {
      this.updateBoard()
      this.renderAnalysisVisualization()
    },
    orientation () {
      this.updateBoard()
      this.renderAnalysisVisualization()
      document.dispatchEvent(new Event('renderPromotion'))
    },
    pieceStyle (pieceStyle) {
      this.updatePieceCSS(pieceStyle)
      document.dispatchEvent(new Event('renderPromotion'))
    },
    boardStyle (boardStyle) {
      this.updateBoardCSS(boardStyle)
    },
    multipv () { this.renderAnalysisVisualization() },
    analysisVisualization: {
      deep: true,
      handler () {
        this.renderAnalysisVisualization()
      }
    },
    hoveredpv () { this.renderAnalysisVisualization() },
    reviewOverlays () {
      this.scheduleBoardInteractionSync('reviewOverlays')
    },
    reviewSequence: {
      deep: true,
      handler () {
        this.scheduleBoardInteractionSync('reviewSequence')
      }
    },
    reviewPreview: {
      deep: true,
      handler () {
        this.scheduleBoardInteractionSync('reviewPreview')
      }
    },
    resized () { this.scheduleBoardInteractionSync('resized') },
    resized9x9width () { this.scheduleBoardInteractionSync('resized9x9width') },
    resized9x9height () { this.scheduleBoardInteractionSync('resized9x9height') },
    resized9x10width () { this.scheduleBoardInteractionSync('resized9x10width') },
    resized9x10height () { this.scheduleBoardInteractionSync('resized9x10height') },
    editorMode () {
      this.updateBoard()
      this.renderAnalysisVisualization()
    },
    variant () {
      if (this.variant === 'shogi') {
        this.piecesW = this.shogiPiecesW
        this.piecesB = this.shogiPiecesB
      }
      if (this.variant === 'crazyhouse') {
        this.piecesW = this.chessPiecesW
        this.piecesB = this.chessPiecesB
      }
      this.resetPockets(this.piecesW)
      this.resetPockets(this.piecesB)
      if (this.board.state.geometry !== this.dimensionNumber) {
        this.board = Chessground(this.$refs.board, {
          coordinates: true,
          fen: this.fen,
          turnColor: 'white',
          resizable: true,
          highlight: {
            lastMove: true, // add last-move class to squares
            check: false // add check class to squares
          },
          drawable: {
            enabled: true, // can draw
            visible: true, // can view
            eraseOnClick: false
          },
          movable: {
            events: { after: this.changeTurn(), afterNewPiece: this.afterDrag() },
            color: 'white',
            free: false
          },
          orientation: this.orientation,
          geometry: this.$store.getters.dimensionNumber
        })

        document.body.dispatchEvent(new Event('chessground.resize'))
      }
      if (this.variant === 'crazyhouse' || this.variant === 'shogi') {
        document.body.dispatchEvent(new Event('chessground.resize'))
      }
      this.board.set({
        variant: this.variant,
        lastMove: false
      })
      this.updateBoard()
      this.isPromotionModalVisible = false
    }
  },
  beforeDestroy () {
    if (this.boardSyncFrame) {
      const caf = window.cancelAnimationFrame || window.clearTimeout
      caf(this.boardSyncFrame)
      this.boardSyncFrame = null
    }
    window.removeEventListener('mouseup', this.stopDragging)
    window.removeEventListener('mousemove', this.doResize)
    window.removeEventListener('wheel', this.reRender)
    window.removeEventListener('mouseup', this.reRender)
  },
  mounted () {
    if (!isNaN(Number(localStorage.resized))) {
      this.enlarged = Number(localStorage.resized)
    }
    if (!isNaN(Number(localStorage.resized9x9width))) {
      this.enlarged9x9width = Number(localStorage.resized9x9width)
      this.enlarged9x9height = Number(localStorage.resized9x9height)
    }
    if (!isNaN(Number(localStorage.resized9x10width))) {
      this.enlarged9x10width = Number(localStorage.resized9x10width)
      this.enlarged9x10height = Number(localStorage.resized9x10height)
    }
    window.addEventListener('mouseup', this.stopDragging)
    window.addEventListener('mousemove', this.doResize)
    window.addEventListener('wheel', this.reRender)
    window.addEventListener('mouseup', this.reRender)

    this.board = Chessground(this.$refs.board, {
      coordinates: true,
      fen: this.fen,
      turnColor: 'white',
      resizable: true,
      highlight: {
        lastMove: true, // add last-move class to squares
        check: true // add check class to squares
      },
      drawable: {
        enabled: true, // can draw
        visible: true, // can view
        eraseOnClick: false
      },
      movable: {
        events: { after: this.changeTurn(), afterNewPiece: this.afterDrag() },
        color: 'white',
        free: false,
        rookCastle: true
      },
      premovable: {
        enabled: false
      },
      events: {
        select: () => this.removeFocusFromInputs(),
        move: () => this.removeFocusFromInputs()
      },
      orientation: this.orientation
    })

    // inject stylesheet placeholders into head
    this.boardStyleEl = document.createElement('link')
    this.boardStyleEl.rel = 'stylesheet'
    this.pieceStyleEl = document.createElement('link')
    this.pieceStyleEl.rel = 'stylesheet'
    document.head.appendChild(this.boardStyleEl)
    document.head.appendChild(this.pieceStyleEl)
    // set initial styles
    this.updateBoardCSS(this.boardStyle)
    this.updatePieceCSS(this.pieceStyle)
    // force initial resize
    document.body.dispatchEvent(new Event('chessground.resize'))
    const boardSize = document.querySelector('.cg-wrap')
    if (Number(localStorage.dimNumber) === 0) {
      boardSize.style.width = 600 + this.enlarged + 'px'
      boardSize.style.height = 600 + this.enlarged + 'px'
      this.startingPoint = this.enlarged
    }
    document.body.dispatchEvent(new Event('chessground.resize'))
    this.renderAnalysisVisualization()
  },
  methods: {
    toBoardKeys (move) {
      let orig = move.substring(0, 2)
      let dest = move.substring(2, 4)
      if (this.dimensionNumber === 3) {
        const extract = this.extractMoves(move)
        orig = extract[0].replace('10', ':')
        dest = extract[1].replace('10', ':')
      }
      return { orig, dest }
    },
    isReviewDebugEnabled () {
      return Boolean(typeof window !== 'undefined' && (window.__LIGROUND_REVIEW_DEBUG__ || (window.localStorage && window.localStorage.reviewDebug === '1')))
    },
    debugBoardInteraction (stage, extra = {}) {
      if (!this.isReviewDebugEnabled()) return
      const source = this.boardStateSource
      const movable = this.board && this.board.state ? this.board.state.movable : null
      const wrap = this.$refs.board && this.$refs.board.querySelector ? this.$refs.board.querySelector('.cg-wrap') : null
      const bounds = wrap && wrap.getBoundingClientRect ? wrap.getBoundingClientRect() : null
      console.debug('[review-sequence-board]', stage, {
        mode: source.mode,
        pointerEvents: this.boardPointerEvents,
        fen: source.fen,
        turnColor: source.turnColor,
        legalMoveCount: source.legalMoves.length,
        movableConfig: extra.movableConfig,
        boardMovable: movable && {
          color: movable.color,
          free: movable.free,
          destCount: movable.dests ? Object.keys(movable.dests).length : 0,
          hasAfter: Boolean(movable.events && movable.events.after),
          hasAfterNewPiece: Boolean(movable.events && movable.events.afterNewPiece)
        },
        bounds: bounds && { width: bounds.width, height: bounds.height, top: bounds.top, left: bounds.left },
        reviewLineLength: this.reviewSequence && this.reviewSequence.line ? this.reviewSequence.line.length : 0,
        ...extra
      })
    },
    scheduleBoardInteractionSync (reason) {
      if (!this.board) return
      if (this.boardSyncFrame) {
        const caf = window.cancelAnimationFrame || window.clearTimeout
        caf(this.boardSyncFrame)
      }
      const raf = window.requestAnimationFrame || (callback => window.setTimeout(callback, 16))
      this.boardSyncFrame = raf(() => {
        this.boardSyncFrame = null
        document.body.dispatchEvent(new Event('chessground.resize'))
        this.updateBoard()
        this.$nextTick(() => {
          document.body.dispatchEvent(new Event('chessground.resize'))
          this.drawShapes()
          this.debugBoardInteraction(`synced:${reason}`)
        })
      })
    },
    stableShapeBrush (brush, fallback = 'blue') {
      if (brush === 'orange') return 'yellow'
      return SAFE_SHAPE_BRUSHES.includes(brush) ? brush : fallback
    },
    stableShapeModifiers (modifiers) {
      if (!modifiers) return undefined
      const lineWidth = Number(modifiers.lineWidth)
      if (Number.isFinite(lineWidth) && lineWidth > 0) {
        return { lineWidth: Math.max(2, Math.min(8, lineWidth)) }
      }
      return undefined
    },
    reviewOverlayToShape (overlay) {
      if (!overlay) return null
      const brush = this.stableShapeBrush(overlay.brush, overlay.kind === 'danger' ? 'red' : 'blue')
      const modifiers = this.stableShapeModifiers(overlay.modifiers)
      if ((overlay.kind === 'arrow' || !overlay.kind) && overlay.orig && overlay.dest) {
        const orig = this.toBoardKeys(`${overlay.orig}${overlay.dest}`).orig
        const dest = this.toBoardKeys(`${overlay.orig}${overlay.dest}`).dest
        return { orig, dest, brush, label: overlay.label, modifiers }
      }
      const square = overlay.square || overlay.orig || overlay.dest
      if (square) {
        const key = this.toBoardKeys(`${square}${square}`).orig
        return { orig: key, brush, label: overlay.label, modifiers }
      }
      return null
    },
    renderAnalysisVisualization () {
      if (this.PvE || this.EvE) return
      if (this.reviewSequenceActive) {
        this.shapes = []
        this.pieceShapes = []
        this.drawShapes()
        return
      }
      if (this.editorMode) {
        // preserve analysis overlays while editing; don't recompute/clear them
        this.drawShapes()
        return
      }
      const cfg = this.analysisVisualization
      const shapes = []
      const pieceShapes = []
      const trajectoryShapes = []
      const multipvShapes = []
      const visibleMultiPv = cfg.multiPvCount > 0 ? this.multipv.slice(0, cfg.multiPvCount) : this.multipv
      const showTrajectoryArrows = cfg.visualizationMode === 'arrow' || cfg.visualizationMode === 'hybrid'
      if (cfg.showMultiPvArrows) {
        for (const [i, pvline] of visibleMultiPv.entries()) {
          if (!pvline || !pvline.ucimove) continue
          const { orig, dest } = this.toBoardKeys(pvline.ucimove)
          const highlighted = i === 0 ? 'yellow' : (i === this.hoveredpv ? 'blue' : 'paleBlue')
          multipvShapes.unshift({ orig, dest, brush: highlighted, modifiers: { lineWidth: 2 + ((visibleMultiPv.length - i) / Math.max(1, visibleMultiPv.length)) * 8 } })
        }
      }
      if (cfg.trajectoryEnabled && this.multipv[0] && this.multipv[0].pvUCI) {
        const trajectoryBrushes = ['red', 'yellow', 'green', 'blue', 'paleBlue']
        const allMoves = this.multipv[0].pvUCI.split(/\s+/).filter(Boolean)
        const maxMoves = cfg.trajectoryUnlimited ? allMoves.length : Math.min(allMoves.length, cfg.trajectoryDepth)
        const tempPieces = { ...(this.board && this.board.state && this.board.state.pieces ? this.board.state.pieces : {}) }
        for (let idx = 0; idx < maxMoves; idx++) {
          if (cfg.trajectorySideMode === 'my' && idx % 2 === 1) continue
          const move = allMoves[idx]
          if (move.includes('@')) continue
          const { orig, dest } = this.toBoardKeys(move)
          const progress = idx / Math.max(1, maxMoves)
          const lineWidth = cfg.orderThickness ? Math.max(1.5, 7 - progress * 5) : 3
          const circled = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳']
          const label = cfg.orderNumbers ? (idx < circled.length ? circled[idx] : String(idx + 1)) : undefined
          const brush = trajectoryBrushes[idx % trajectoryBrushes.length]
          if (showTrajectoryArrows) {
            trajectoryShapes.push({ orig, dest, brush, label, modifiers: { lineWidth } })
          }
          if (cfg.visualizationMode === 'ghost' || cfg.visualizationMode === 'hybrid') {
            const pieceOnOrig = tempPieces[orig]
            const normalizedColor = pieceOnOrig && (pieceOnOrig.color === 'white' || pieceOnOrig.color === true ? 'white' : (pieceOnOrig.color === 'black' || pieceOnOrig.color === false ? 'black' : null))
            if (!pieceOnOrig || !pieceOnOrig.role || !normalizedColor) {
              if (this.isReviewDebugEnabled()) console.warn('[viz] invalid ghost piece', { idx, orig, dest, pieceOnOrig })
            } else {
              const ghostOpacity = idx === 0 ? 0.65 : (idx === 1 ? 0.45 : 0.25)
              const ghostShape = {
                orig: dest,
                piece: { role: pieceOnOrig.role, color: normalizedColor },
                brush: 'paleBlue',
                modifiers: { opacity: ghostOpacity, lineWidth: 1.5 }
              }
              if (ghostShape.piece && ghostShape.piece.role && ghostShape.piece.color) {
                pieceShapes.push(ghostShape)
              }
            }
          }
          if (tempPieces[orig]) {
            tempPieces[dest] = tempPieces[orig]
            delete tempPieces[orig]
          }
        }
      }
      this.shapes = [...multipvShapes, ...trajectoryShapes]
      this.pieceShapes = pieceShapes
      if (this.isReviewDebugEnabled()) console.debug('[viz] multipvShapes=', multipvShapes.length, 'trajectoryShapes=', trajectoryShapes.length, 'ghostShapes=', pieceShapes.length, 'cfg=', cfg, 'multipvRaw=', this.multipv)
      this.drawShapes()
    },
    closeCursorHand () {
      const board = document.querySelector('.cg-wrap')
      board.style.cursor = 'grabbing'
    },
    openCursorHand () {
      const board = document.querySelector('.cg-wrap')
      board.style.cursor = 'grab'
    },
    reRender (event) {
      document.body.dispatchEvent(new Event('chessground.resize'))
    },
    hideShade () {
      if (this.dragging === false) {
        document.querySelector('.resizer').style.opacity = 0.0
      }
    },
    shade () {
      document.querySelector('.resizer').style.opacity = 0.8
    },
    stopDragging () {
      document.querySelector('.resizer').style.opacity = 0.0
      this.dragging = false
    },
    startDragging () {
      this.dragging = true
      document.querySelector('.resizer').style.opacity = 0.8
    },
    doResize (event) {
      const boardSize = document.querySelector('.cg-wrap')
      if (this.dragging === false) {
        return
      }
      if (event.clientY - this.startingPoint > 40) {
        switch (this.dimensionNumber) {
          case 0:
            if (this.enlarged < 200) {
              this.enlarged += 40
            }
            break
          case 1:
            if (this.enlarged9x9width < 200) {
              this.enlarged9x9width += 35
              this.enlarged9x9height += (35 * 1.153846153846154) // to get the aspect ration of 1.153 width to height
            }
            break
          case 3:
            if (this.enlarged9x10width < 200) {
              this.enlarged9x10width += 35
              this.enlarged9x10height += (35 * 1.111111111111111)
            }
            break
        }
        this.startingPoint = event.clientY
      } else if (event.clientY - this.startingPoint < -40) {
        switch (this.dimensionNumber) {
          case 0:
            if (this.enlarged > -200) {
              this.enlarged -= 40
            }
            break
          case 1:
            if (this.enlarged9x9width > -200) {
              this.enlarged9x9width -= 35
              this.enlarged9x9height -= (35 * 1.153846153846154)
            }
            break
          case 3:
            if (this.enlarged9x10width > -200) {
              this.enlarged9x10width -= 35
              this.enlarged9x10height -= (35 * 1.111111111111111)
            }
            break
        }
        this.startingPoint = event.clientY
      }
      if (this.dimensionNumber === 0 && (this.enlarged <= 200 && this.enlarged >= -200)) {
        boardSize.style.width = 600 + this.enlarged + 'px'
        boardSize.style.height = 600 + this.enlarged + 'px'
        document.body.dispatchEvent(new Event('chessground.resize'))
      } else if (this.dimensionNumber === 1 && (this.enlarged9x9width <= 200 && this.enlarged9x9width >= -200)) {
        boardSize.style.width = 520 + this.enlarged9x9width + 'px'
        boardSize.style.height = 600 + this.enlarged9x9height + 'px'
        document.body.dispatchEvent(new Event('chessground.resize'))
      } else if (this.dimensionNumber === 3 && (this.enlarged9x10width <= 200 && this.enlarged9x10width >= -200)) {
        boardSize.style.width = 540 + this.enlarged9x10width + 'px'
        boardSize.style.height = 600 + this.enlarged9x10height + 'px'
        document.body.dispatchEvent(new Event('chessground.resize'))
      }

      this.boardWidth = boardSize.style.width
      this.boardHeight = boardSize.style.height
      this.$store.dispatch('setResized', this.enlarged)
      this.$store.dispatch('setResized9x9height', this.enlarged9x9height)
      this.$store.dispatch('setResized9x10height', this.enlarged9x10height)
      this.$store.dispatch('setResized9x9width', this.enlarged9x9width)
      this.$store.dispatch('setResized9x10width', this.enlarged9x10width)
    },
    resize (event) {
      const boardSize = document.querySelector('.cg-wrap')
      if (event.deltaY > 0) {
        switch (this.dimensionNumber) {
          case 0:
            if (this.enlarged < 200) {
              this.enlarged += 40
              this.startingPoint += 40
            }
            break
          case 1:
            if (this.enlarged9x9width < 200) {
              this.enlarged9x9width += 35
              this.enlarged9x9height += (35 * 1.153846153846154)
              this.startingPoint += (35 * 1.153846153846154)
            }
            break
          case 3:
            if (this.enlarged9x10width < 200) {
              this.enlarged9x10width += 35
              this.enlarged9x10height += (35 * 1.111111111111111) // to get the aspect ration of 1.11111 width to height
              this.startingPoint += (35 * 1.111111111111111)
            }
            break
        }
      } else if (event.deltaY < 0) {
        switch (this.dimensionNumber) {
          case 0:
            if (this.enlarged > -200) {
              this.enlarged -= 40
              this.startingPoint -= 40
            }
            break
          case 1:
            if (this.enlarged9x9width > -200) {
              this.enlarged9x9width -= 35
              this.enlarged9x9height -= (35 * 1.153846153846154)
              this.startingPoint -= (35 * 1.153846153846154)
            }
            break
          case 3:
            if (this.enlarged9x10width > -200) {
              this.enlarged9x10width -= 35
              this.enlarged9x10height -= (35 * 1.111111111111111)
              this.startingPoint -= (35 * 1.111111111111111)
            }
            break
        }
      }

      if (this.dimensionNumber === 0 && (this.enlarged <= 200 && this.enlarged >= -200)) {
        boardSize.style.width = 600 + this.enlarged + 'px'
        boardSize.style.height = 600 + this.enlarged + 'px'
        document.body.dispatchEvent(new Event('chessground.resize'))
      } else if (this.dimensionNumber === 1 && (this.enlarged9x9width <= 200 && this.enlarged9x9width >= -200)) {
        boardSize.style.width = 520 + this.enlarged9x9width + 'px'
        boardSize.style.height = 600 + this.enlarged9x9height + 'px'
        document.body.dispatchEvent(new Event('chessground.resize'))
      } else if (this.dimensionNumber === 3 && (this.enlarged9x10width <= 200 && this.enlarged9x10width >= -200)) {
        boardSize.style.width = 540 + this.enlarged9x10width + 'px'
        boardSize.style.height = 600 + this.enlarged9x10height + 'px'
        document.body.dispatchEvent(new Event('chessground.resize'))
      }
      this.boardWidth = boardSize.style.width
      this.boardHeight = boardSize.style.height
      this.$store.dispatch('setResized', this.enlarged)
      this.$store.dispatch('setResized9x9height', this.enlarged9x9height)
      this.$store.dispatch('setResized9x10height', this.enlarged9x10height)
      this.$store.dispatch('setResized9x9width', this.enlarged9x9width)
      this.$store.dispatch('setResized9x10width', this.enlarged9x10width)
    },
    showPromotionModal () {
      this.isPromotionModalVisible = true
    },
    closePromotionModal (value) {
      this.isPromotionModalVisible = false
      this.promotionMove = this.promotionMove + value
      if (this.reviewSequenceActive) {
        this.handleReviewSequenceMove(this.promotionMove, 'promotion')
        return
      }
      this.lastMoveSan = this.$store.getters.sanMove(this.promotionMove)
      const prevMov = this.currentMove
      this.$store.dispatch('push', { move: this.promotionMove, prev: prevMov }).then(() => {
        this.$store.dispatch('onHumanMoveComplete')
      })
      this.updateHand()
      this.afterMove()
    },
    updatePieceCSS (pieceStyle) {
      const node = this.pieceStyleEl
      if (this.$store.getters.isInternational) {
        node.href = '../../../../static/piece-css/international/' + pieceStyle + '.css'
      } else if (this.$store.getters.isSEA) {
        node.href = '../../../../static/piece-css/sea/' + pieceStyle + '.css'
      } else if (this.$store.getters.isXiangqi || this.$store.getters.isJanggi) {
        node.href = '../../../../static/piece-css/xiangqi/' + pieceStyle + '.css'
      } else if (this.$store.getters.isShogi) {
        node.href = '../../../../static/piece-css/shogi/' + pieceStyle + '.css'
      }
    },
    updateBoardCSS (boardStyle) {
      const node = this.boardStyleEl
      if (this.$store.getters.isInternational) {
        node.href = '../../../../static/board-css/international/' + boardStyle + '.css'
      } else if (this.$store.getters.isXiangqi || this.$store.getters.isJanggi) {
        const boardVariant = this.variant === 'janggimodern' ? 'janggi' : this.variant
        node.href = '../../../../static/board-css/xiangqi/' + boardVariant + '/' + boardStyle + '.css'
      } else if (this.$store.getters.isSEA) {
        node.href = '../../../../static/board-css/sea/' + boardStyle + '.css'
      } else if (this.$store.getters.isShogi) {
        node.href = '../../../../static/board-css/shogi/' + boardStyle + '.css'
      }
      document.body.dispatchEvent(new Event('chessground.resize'))
    },
    dropPiece (event, pieceType, color) {
      this.board.dragNewPiece({ role: pieceType, color: color, promoted: false }, event)
      this.selectedPiece = pieceType
    },
    extractMoves (move) {
      const letters = move.split(/(\d+)/)
      let first = ''
      let second = ''
      let firstcomplete = false
      for (const i in letters) {
        if (isNaN(parseInt(letters[i])) && first.length !== 0) {
          firstcomplete = true
        }
        if (firstcomplete === false) {
          first += letters[i]
        }
        if (firstcomplete) {
          second += letters[i]
        }
      }
      const ret = [first, second]
      return ret
    },
    increaseNumbers (move) {
      const letters = move.split(/(\d+)/)
      letters[1] = String(parseInt(letters[1]) + 1)
      letters[3] = String(parseInt(letters[3]) + 1)
      const ret = letters.join('')
      return ret
    },
    lowerNumbers (move) {
      const letters = move.split(/(\D)/)
      letters[2] = String(parseInt(letters[2]) - 1)
      letters[4] = String(parseInt(letters[4]) - 1)
      const ret = letters.join('')
      return ret
    },
    possibleMoves (moves = this.legalMoves) {
      const dests = {}
      const legalMoves = Array.isArray(moves) ? moves : String(moves || '').split(/\s+/).filter(Boolean)

      for (let i = 0; i < legalMoves.length; i++) {
        const Move = legalMoves[i]
        let fromSq
        let toSq
        // don't include drops, pass/null moves, or malformed moves in drag destinations
        if (!Move || Move.includes('@') || Move === '0000' || Move.length < 4) {
          continue
        }
        fromSq = Move.substring(0, 2)
        toSq = Move.substring(2, 4)
        if (this.dimensionNumber === 3) {
          const extract = this.extractMoves(Move)
          fromSq = extract[0].replace('10', ':')
          toSq = extract[1].replace('10', ':')
        }
        if (!fromSq || !toSq) continue
        if (fromSq in dests) {
          dests[fromSq].push(toSq)
        } else {
          dests[fromSq] = [toSq]
        }
      }
      return dests
    },
    isPromotion (uciMove, legalMoves = this.legalMoves) {
      for (let i = 0; i < legalMoves.length; i++) {
        if (this.dimensionNumber === 3) {
          return false
        }
        if (legalMoves[i].length === 5) {
          if (legalMoves[i].includes(uciMove)) {
            return true
          }
        }
      }
      return false
    },
    setPromotionOptions (uciMove) {
      if (this.$store.getters.isInternational) {
        if (this.variant === 'antichess') {
          this.promotions = [
            { type: 'k-piece' },
            { type: 'q-piece' },
            { type: 'r-piece' },
            { type: 'b-piece' },
            { type: 'n-piece' }
          ]
        } else {
          this.promotions = [
            { type: 'q-piece' },
            { type: 'r-piece' },
            { type: 'b-piece' },
            { type: 'n-piece' }
          ]
        }
      }
      if (this.variant === 'shogi') {
        const key = uciMove.substring(2, 4)
        const type = this.board.state.pieces[key].role
        let num = 0
        let promo = false
        for (let i = 0; i < this.legalMoves.length; i++) {
          if (this.legalMoves[i].includes(uciMove)) {
            num = num + 1
            if (this.legalMoves[i].includes('+')) {
              promo = true
            }
          }
        }
        if (type === 'p-piece') {
          this.promotions = [
            { type: 'p-piece' },
            { type: 'pp-piece' }
          ]
        } else if (type === 'l-piece') {
          this.promotions = [
            { type: 'l-piece' },
            { type: 'pl-piece' }
          ]
        } else if (type === 'n-piece') {
          this.promotions = [
            { type: 'n-piece' },
            { type: 'pn-piece' }
          ]
        } else if (type === 's-piece') {
          this.promotions = [
            { type: 's-piece' },
            { type: 'ps-piece' }
          ]
        } else if (type === 'b-piece') {
          this.promotions = [
            { type: 'b-piece' },
            { type: 'pb-piece' }
          ]
        } else if (type === 'r-piece') {
          this.promotions = [
            { type: 'r-piece' },
            { type: 'pr-piece' }
          ]
        }
        if (num === 1 && promo) {
          this.promotions = [this.promotions[1]]
        }
      }
    },
    resetPockets (pieces) {
      for (let idx = 0; idx < pieces.length; idx++) {
        pieces[idx].count = 0
      }
    },
    afterDrag () {
      return (role, key) => {
        const mode = this.boardInteractionMode
        if (mode === BOARD_INTERACTION_MODES.REVIEW_SEQUENCE) {
          const pieces = { 'p-piece': 'P', 'n-piece': 'N', 'b-piece': 'B', 'r-piece': 'R', 'q-piece': 'Q', 's-piece': 'S', 'g-piece': 'G', 'l-piece': 'L' }
          const move = pieces[role] + '@' + key
          this.handleReviewSequenceMove(move, 'drop')
          return
        }
        if (mode === BOARD_INTERACTION_MODES.BOARD_EDITOR) {
          this.$store.dispatch('fen', this.board.getFen())
          this.$store.dispatch('lastFen', this.board.getFen())
          return
        }
        const pieces = { 'p-piece': 'P', 'n-piece': 'N', 'b-piece': 'B', 'r-piece': 'R', 'q-piece': 'Q', 's-piece': 'S', 'g-piece': 'G', 'l-piece': 'L' }
        const move = pieces[role] + '@' + key
        const prevMov = this.currentMove
        if (this.$store.getters.legalMoves.includes(move)) {
          this.$store.dispatch('push', { move: move, prev: prevMov }).then(() => {
            this.$store.dispatch('onHumanMoveComplete')
          })
          this.updateHand()
        } else {
          this.updateBoard()
        }
      }
    },
    changeTurn () {
      return (orig, dest, metadata) => {
        const mode = this.boardInteractionMode
        if (mode === BOARD_INTERACTION_MODES.BOARD_EDITOR) {
          const editedFen = this.board.getFen()
          this.$store.dispatch('fen', editedFen)
          this.$store.dispatch('lastFen', editedFen)
          this.board.state.lastMove = [orig, dest]
          this.drawShapes()
          return
        }
        let uciMove = orig + dest
        if (this.dimensionNumber === 3) {
          uciMove = uciMove.replaceAll(':', '10') // Convert the ':' back to '10'
        }
        if (mode === BOARD_INTERACTION_MODES.REVIEW_SEQUENCE) {
          this.handleReviewSequenceMove(uciMove, 'move')
          return
        }
        if (this.isPromotion(uciMove, this.boardStateSource.legalMoves)) {
          if (this.variant === 'makruk') {
            const move = uciMove + 'm'
            const prevMov = this.currentMove
            this.$store.dispatch('push', { move: move, prev: prevMov }).then(() => {
              this.$store.dispatch('onHumanMoveComplete')
            })
          } else {
            this.setPromotionOptions(uciMove)
            this.promotionMove = uciMove
            this.showPromotionModal()
          }
        } else {
          this.lastMoveSan = this.$store.getters.sanMove(uciMove)
          const prevMov = this.currentMove
          this.$store.dispatch('push', { move: uciMove, prev: prevMov }).then(() => {
            this.$store.dispatch('onHumanMoveComplete')
          })
          this.updateHand()
          this.afterMove()
        }
      }
    },

    handleReviewSequenceMove (move, source) {
      this.debugBoardInteraction(`review-${source}:before`, { move })
      this.$store.dispatch('addReviewSequenceMove', move).then(accepted => {
        if (!accepted) {
          this.updateBoard()
          this.drawShapes()
        }
        this.$nextTick(() => {
          document.body.dispatchEvent(new Event('chessground.resize'))
          this.debugBoardInteraction(`review-${source}:after`, { move, accepted })
        })
      })
    },
    updatePocket (pocket, pocketPieces, color) {
      for (let idx = 0; idx < pocketPieces.length; ++idx) {
        let pieceIdx
        if (this.variant === 'shogi') {
          if (color === WHITE) {
            pieceIdx = this.shogiPiecesToIdx[pocketPieces[idx].toUpperCase()]
          } else {
            pieceIdx = this.shogiPiecesToIdx[pocketPieces[idx]]
          }
        } else {
          if (color === WHITE) {
            pieceIdx = this.piecesToIdx[pocketPieces[idx].toUpperCase()]
          } else {
            pieceIdx = this.piecesToIdx[pocketPieces[idx]]
          }
        }
        pocket[pieceIdx].count += 1
      }
    },
    updateHand () {
      // Crazyhouse pocket pieces
      this.resetPockets(this.piecesW)
      this.resetPockets(this.piecesB)
      if (this.fen === this.lastFen) {
        this.updatePocket(this.piecesW, this.$store.getters.pocket(WHITE), WHITE)
        this.updatePocket(this.piecesB, this.$store.getters.pocket(BLACK), BLACK)
      } else {
        let i = 0
        for (let num = 0; num < this.moves.length; num++) { // i will have the index of the currently displayed move
          if (this.moves[num].fen === this.fen) {
            i = num
            break
          }
        }
        this.updatePocket(this.piecesW, this.moves[i].whitePocket, WHITE) // load the pocketpieces from the currently displayed move
        this.updatePocket(this.piecesB, this.moves[i].blackPocket, BLACK)
      }
    },
    afterMove () {
      const events = {}
      events.fen = this.fen
      events.history = [this.lastMoveSan]
      // this.$emit('onMove', events)
      this.$store.dispatch('lastFen', this.fen)
    },
    updateBoard () {
      const source = this.boardStateSource
      const reviewMode = source.mode === BOARD_INTERACTION_MODES.REVIEW_SEQUENCE || source.mode === BOARD_INTERACTION_MODES.REVIEW_PREVIEW
      // logic to find out if a check should be displayed:
      let isCheck = false // ensures that no check is displayed when the current move was not a check
      if (!reviewMode && source.mode !== BOARD_INTERACTION_MODES.BOARD_EDITOR && this.currentMove !== undefined && (this.currentMove.name.includes('+') || this.currentMove.name.includes('#'))) { // the last move was check iff the san notation of the last move contained a '+'
        this.moves[this.moves.length - 1].check = this.turn // the check property of the board accepts a color or a boolean
        isCheck = this.currentMove.check
      }
      // logic to find out which move was last and should thus be highlighted:
      const lastMoveString = source.lastMove
      if (!lastMoveString || (!reviewMode && this.moves.length === 0)) {
        this.board.state.lastMove = undefined
      } else {
        const string = String(lastMoveString)
        let first = string.substring(0, 2)
        let second = string.substring(2, 4)
        if (this.dimensionNumber === 3) {
          const extract = this.extractMoves(string)
          first = extract[0].replace('10', ':')
          second = extract[1].replace('10', ':') // the 10th rank is represented as ":"
        }
        if (string.includes('@')) { // no longer displays a green box in the corner
          this.board.state.lastMove = [second]
        } else {
          this.board.state.lastMove = [first, second]
        }
      }
      const movableEvents = { after: this.changeTurn(), afterNewPiece: this.afterDrag() }
      const movable = source.free
        ? {
            free: true,
            color: 'both',
            dests: undefined,
            events: movableEvents
          }
        : source.movable
        ? {
            free: false,
            dests: this.possibleMoves(source.legalMoves),
            color: reviewMode ? 'both' : source.turnColor,
            events: movableEvents,
            rookCastle: true
          }
        : {
            free: false,
            dests: {},
            color: source.turnColor,
            events: movableEvents
          }
      this.debugBoardInteraction('updateBoard:before', { movableConfig: movable })
      this.board.set({
        check: isCheck,
        fen: source.fen,
        turnColor: source.turnColor,
        highlight: {
          lastMove: true,
          check: true
        },
        movable,
        drawable: {
          enabled: !reviewMode,
          visible: true,
          eraseOnClick: false
        },
        orientation: this.orientation
      })
      this.debugBoardInteraction('updateBoard:after', { movableConfig: movable })
      if (!reviewMode && (this.variant === 'crazyhouse' || this.variant === 'shogi')) {
        this.updateHand()
      }
    },
    drawShapes () {
      if (this.board !== null) {
        const reviewShapes = (this.reviewOverlays || []).map(this.reviewOverlayToShape).filter(Boolean)
        const baseShapes = (this.reviewSequenceActive || this.reviewPreviewActive) ? [] : this.shapes
        const basePieceShapes = (this.reviewSequenceActive || this.reviewPreviewActive) ? [] : this.pieceShapes
        const combinedShapes = [...baseShapes, ...basePieceShapes, ...reviewShapes].map(shape => {
          if (!shape) return null
          return {
            ...shape,
            brush: this.stableShapeBrush(shape.brush, 'blue'),
            modifiers: this.stableShapeModifiers(shape.modifiers)
          }
        }).filter(Boolean)
        if (this.board.state.lastMove && this.board.state.lastMove.length === 2) {
          combinedShapes.push({ orig: this.board.state.lastMove[0], dest: this.board.state.lastMove[1], brush: 'green' })
        }
        this.board.setAutoShapes(combinedShapes)
        this.debugBoardInteraction('drawShapes', { shapeCount: combinedShapes.length, reviewShapeCount: reviewShapes.length })
      }
    },
    removeFocusFromInputs () {
      if (document.activeElement.nodeName.toLowerCase() === 'input') {
        document.activeElement.blur()
      }
    }
  }
}
</script>

<style>
@import '../assets/chessground.css';
@import '../assets/dim9x9.css';
@import '../assets/dim8x8.css';
@import '../assets/dim9x10.css';

.resizer{
  padding-left: 5px;
  padding-top: 5px;
  position: absolute;
  width: 10px;
  height: 10px;
  border-radius: 5px;
  background-color: red;
  z-index: 2;
  bottom: -1px;
  right: -1px;
  cursor: se-resize;
  opacity: 0.0;
  }
#PromotionModal {
  position: absolute;
  z-index: 4;
  width: 12.5%;
  height: 62.5%;
}
.mirror {
  transform: scaleY(-1);
}
.chess-pocket {
  float: left;
  background-color: #000;
}
.grid-parent {
  display: grid;
  grid-template-columns: auto 1fr
}
.pockets {
  margin-right: 1.5px;
  height: 100%;
  background-color: var(--second-bg-color);
  border-radius: 5px;
}
.pockets.shogi{
  display:grid;
  grid-template-columns: 1fr 1fr ;

}
.cg-board-wrap {
  position: relative;
}
.cg-wrap svg {
  overflow: visible;
  opacity: 0.88;
  z-index: 6;
  pointer-events: none;
}
.cg-wrap svg .brush-red,
.cg-wrap svg .brush-yellow,
.cg-wrap svg .brush-green,
.cg-wrap svg .brush-blue {
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.65));
}
.koth cg-container::before {
  width: 25%;
  height: 25%;
  box-shadow: 0 0 10px rgba(0,0,0,0.7);
  background: rgba(230,230,230,0.2);
  content: '';
  position: absolute;
  top: 37.5%;
  left: 37.5%;
  z-index: 1;
  pointer-events: none;
  border-radius: 0px 0px 0px 0px;
}
.rk cg-board::before{
    background: rgba(230,230,230,0.2);
    width: 100%;
    height: 12.5%;
    box-shadow: 0 0 10px rgba(0,0,0,0.7);
    content: '';
    position: absolute;
    left: 0;
    z-index: 1;
    pointer-events: none;
    border-radius: 4px 4px 0px 0px;
}
/*
  CSS for 9x10 board e.g. xiangqi/janggi etc.
*/

</style>
