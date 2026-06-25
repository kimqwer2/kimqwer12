<template>
  <!-- All components but menubar -->
  <div id="inner">
    <button
      v-if="focusMode"
      class="focus-mode-exit"
      type="button"
      title="Exit Focus Mode (Esc)"
      @click="exitFocusMode"
    >
      Exit Focus Mode
    </button>
    <div>
      <div
        :class="['main-grid', { 'focus-mode': focusMode }]"
        @wheel.exact="routeWheelToRightPanel"
      >
        <div class="chessboard-grid">
          <div class="board-grid">
            <div class="board">
              <span>
                <GameInfo
                  v-if="QuickTourIndex !== 15"
                  id="gameinfo"
                />
                <GameInfo
                  v-else
                  id="gameinfo-qt"
                />
              </span>
              <div
                class="scrollable"
                @mousewheel.prevent.exact="scroll($event)"
              >
                <ChessGround
                  v-if="QuickTourIndex !== 2"
                  id="chessboard"
                  :orientation="orientation"
                  @onMove="showInfo"
                />
                <ChessGround
                  v-else
                  id="chessboard-qt"
                  :orientation="orientation"
                  @onMove="showInfo"
                />
              </div>
              <EvalBar
                v-if="QuickTourIndex !== 3"
                v-show="!focusMode"
                class="evalbar"
              />
              <EvalBar
                v-else
                class="evalbar-qt"
              />
            </div>
          </div>
          <div
            v-if="QuickTourIndex !== 4"
            id="fen-field"
          >
            FEN <input
              id="lname"
              type="text"
              name="lname"
              placeholder="fen position"
              :value="fen"
              :size="setFenSize()"
              @change="checkValidFEN"
            >
          <div
            v-if="opening"
            class="opening-label"
          >
            {{ opening.eco }} – {{ opening.name }}
          </div>
          <div class="game-sequence-row">
            <button
              class="mini-btn"
              @click="copySequence"
            >
              전체 수순 복사
            </button>
            <button
              class="mini-btn"
              @click="copyWinBoardSequence"
            >
              WinBoard 전체 수순 복사
            </button>
            <button
              class="mini-btn"
              @click="copyWinBoardPosition"
            >
              WinBoard Position Copy
            </button>
            <button
              class="mini-btn"
              @click="pasteWinBoardPosition"
            >
              WinBoard Position Paste
            </button>
            <button
              class="mini-btn"
              @click="pasteSequence"
            >
              수순 붙여넣기
            </button>
            <button
              class="mini-btn"
              @click="addCurrentToOpeningBook"
            >
              현재 기보를 오프닝북에 추가
            </button>
          </div>
          <div
            v-if="showOpeningSuggestions"
            class="opening-candidates"
          >
            <div class="opening-candidates-title">
              <span>오프닝 추천 수</span>
              <button
                class="candidate-detail-toggle"
                type="button"
                @click.stop="showOpeningCandidateDetails = !showOpeningCandidateDetails"
              >
                {{ showOpeningCandidateDetails ? '간단히' : '상세' }}
              </button>
            </div>
            <div
              v-for="(cand, idx) in openingCandidates.slice(0, recommendationDisplayCount)"
              :key="`${cand.uci}-${idx}`"
              class="candidate-card"
              @contextmenu.prevent="removeOpeningCandidate(cand)"
            >
              <button
                class="candidate-btn"
                type="button"
                :title="candidateUi(cand).reason"
                @click="playCandidate(cand.uci)"
              >
                <span class="candidate-main">
                  <strong>{{ cand.uci }}</strong>
                  <span>{{ candidateUi(cand).shareText }}</span>
                </span>
                <span class="candidate-chips">
                  <span class="candidate-chip weight">추천 {{ candidateUi(cand).shareText }}</span>
                  <span class="candidate-chip practical">{{ candidateUi(cand).practicalText }}</span>
                  <span class="candidate-chip">{{ candidateUi(cand).tag }}</span>
                  <span class="candidate-chip">{{ candidateUi(cand).confidenceText }}</span>
                </span>
                <span class="candidate-reason">{{ candidateUi(cand).reason }}</span>
              </button>
              <div
                v-if="showOpeningCandidateDetails"
                class="candidate-debug"
              >
                <span>상대차 {{ candidateUi(cand).cpDeltaText }}</span>
                <span>효과CP {{ candidateUi(cand).effectiveCpText }}</span>
                <span>신뢰 {{ candidateUi(cand).confidencePercent }}</span>
                <span>깊이 {{ candidateUi(cand).avgDepthText }}</span>
                <span>표본 {{ candidateUi(cand).samplesText }}</span>
                <span>변동 {{ candidateUi(cand).cpStdDevText }}</span>
                <span>가중 {{ candidateUi(cand).qualityWeightText }}</span>
                <span>수동 {{ candidateUi(cand).manualBoostText }}</span>
              </div>
            </div>
          </div>
        </div>
          <div
            v-else
            id="fen-field-qt"
          >
            FEN <input
              id="lname"
              type="text"
              name="lname"
              placeholder="fen position"
              :value="fen"
              :size="setFenSize()"
              @change="checkValidFEN"
            >
            <div
              v-if="opening"
              class="opening-label"
            >
              {{ opening.eco }} – {{ opening.name }}
            </div>
          </div>
          <JumpButtons
            v-if="QuickTourIndex !== 14"
            id="jump-buttons"
            @flip-board="flipBoard"
            @move-to-start="moveToStart"
            @move-back-one="moveBackOne"
            @move-forward-one="moveForwardOne"
            @move-to-end="moveToEnd"
          />
          <JumpButtons
            v-else
            id="jump-buttons-qt"
            @flip-board="flipBoard"
            @move-to-start="moveToStart"
            @move-back-one="moveBackOne"
            @move-forward-one="moveForwardOne"
            @move-to-end="moveToEnd"
          />
        </div>
        <EvalPlot
          v-if="QuickTourIndex !== 6"
          v-show="!focusMode"
          id="evalplot"
        />
        <EvalPlot
          v-else
          id="evalplot-qt"
        />
        <div v-show="!focusMode" id="right-column">
          <AnalysisView
            id="analysisview"
            class="tab"
            :class="{ visible: viewAnalysis }"
            :reset="resetAnalysis"
            @move-to-start="moveToStart"
            @move-to-end="moveToEnd"
            @move-back-one="moveBackOne"
            @move-forward-one="moveForwardOne"
            @flip-board="flipBoard"
          />
          <SettingsTab
            id="settingstab"
            class="tab"
            :class="{ visible: !viewAnalysis }"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import AnalysisView from './AnalysisView'
import EvalBar from './EvalBar'
import ChessGround from './ChessGround'
import EvalPlot from './EvalPlot'
import JumpButtons from './JumpButtons'
import Vue from 'vue'
import SettingsTab from './SettingsTab'
import GameInfo from './GameInfo.vue'
import { findBestOpeningForFen } from '../../shared/openingLookup'
import { parseGameSequence, serializeGameSequence } from '../../shared/gameSequence'
import { deserializeWinBoardFen, serializeWinBoardFen, serializeWinBoardGame } from '../../shared/winboardExport'
import { copyTextReliable, readTextReliable } from '../../shared/clipboard'
import { mapGetters } from 'vuex'

export default {
  name: 'GameBoards',
  components: {
    AnalysisView,
    EvalBar,
    ChessGround,
    EvalPlot,
    JumpButtons,
    GameInfo,
    SettingsTab
  },
  data () {
    return {
      positionInfo: '',
      game: null,
      resetAnalysis: false,
      keydownHandler: null,
      autoReplyBusy: false,
      showOpeningCandidateDetails: false
    }
  },
  computed: {
    viewAnalysis () {
      return this.$store.getters.viewAnalysis
    },
    variant () {
      return this.$store.getters.variant
    },
    orientation () {
      return this.$store.getters.orientation
    },
    moves () {
      return this.$store.getters.moves
    },
    fen () {
      return this.$store.getters.fen
    },
    opening () {
      if (!this.fen) return null
      // only makes sense for standard chess
      if (this.variant && this.variant !== 'chess') return null
      return this.findOpeningProgressive()
    },
    mainFirstMove () {
      return this.$store.getters.mainFirstMove
    },
    startFen () {
      return this.$store.getters.startFen
    },
    currentMove () { // returns undefined when the current fen doesnt match a move from the history, otherwise it returns move from the moves array that matches the current fen
      for (let num = 0; num < this.moves.length; num++) { // beware that it matches by current FEN, not the one after dispatching a new one
        if (this.moves[num].fen === this.fen) {
          return this.moves[num]
        }
      }
      return undefined
    },
    openingCandidates () {
      return this.$store.getters.openingCandidates || []
    },
    openingBook () {
      return this.$store.getters.openingBook || {}
    },
    recommendationDisplayCount () {
      return Math.max(1, Math.min(8, Number(this.openingBook.recommendationCount) || 3))
    },
    showOpeningSuggestions () {
      return this.openingBook.enabled && this.openingBook.showSuggestions && this.openingCandidates.length > 0
    },
    focusMode () {
      return this.$store.getters.focusMode
    },
    ...mapGetters(['QuickTourIndex'])
  },
  mounted () { // EventListener für Keyboardinput, ruft direkt die jeweilige Methode auf
    console.log('[FocusMode] UI updated', { focusMode: this.focusMode })
    this.keydownHandler = (event) => {
      const keyName = event.key
      const target = event.target
      const tag = target && target.nodeName ? target.nodeName.toLowerCase() : ''
      const isEditable = target && (target.isContentEditable || tag === 'textarea' || tag === 'select' || (tag === 'input' && target.type.toLowerCase() !== 'checkbox'))
      if (keyName === 'Escape' && this.focusMode) {
        event.preventDefault()
        this.exitFocusMode()
        return
      }
      if (!isEditable) {
        if (keyName === 'ArrowUp') {
          event.preventDefault()
          this.moveToStart()
        }
        if (keyName === 'ArrowDown') {
          event.preventDefault()
          this.moveToEnd()
        }
        if (keyName === 'ArrowLeft') {
          event.preventDefault()
          this.moveBackOne()
        }
        if (keyName === 'ArrowRight') {
          event.preventDefault()
          this.moveForwardOne()
        }
        if (keyName === 'n') {
          event.preventDefault()
          this.openNextGame()
        }
        if (keyName === 'p') {
          event.preventDefault()
          this.openPrevGame()
        }
        if (event.ctrlKey && keyName.toLowerCase() === 'a') {
          event.preventDefault()
          this.$store.dispatch('toggleAnalysisMode')
        }
        if (event.ctrlKey && keyName.toLowerCase() === 'e') {
          event.preventDefault()
          this.$store.dispatch('toggleEditorMode')
        }
        if (keyName === 'F2') {
          event.preventDefault()
          this.flipBoard()
        }
        if (event.ctrlKey && keyName.toLowerCase() === 'g') {
          event.preventDefault()
          this.$store.dispatch('analysisVisualization', {
            realtimeGameCommentary: !this.$store.getters.analysisVisualization.realtimeGameCommentary
          })
        }
        if (event.ctrlKey && keyName.toLowerCase() === 'w') {
          event.preventDefault()
          this.$store.dispatch('playSingleEngineMove')
        }
        if (event.ctrlKey && keyName.toLowerCase() === 'c') {
          const selection = window.getSelection ? window.getSelection() : null
          if (selection && selection.toString().trim().length > 0) return
          event.preventDefault()
          this.copySequence()
        }
        if (event.ctrlKey && keyName.toLowerCase() === 'v') {
          event.preventDefault()
          this.pasteSequence()
        }
        if (event.ctrlKey && keyName.toLowerCase() === 't') {
          event.preventDefault()
          const autoPlayBtn = document.getElementById('engine-auto-play-btn')
          if (autoPlayBtn) autoPlayBtn.click()
        }
      }
    }
    window.addEventListener('keydown', this.keydownHandler, false)
  },
  watch: {
    fen () {
      this.tryAutoOpeningResponse()
    },
    focusMode (value) {
      this.$nextTick(() => {
        console.log('[FocusMode] UI updated', { focusMode: value })
      })
    }
  },
  beforeDestroy () {
    if (this.keydownHandler) {
      window.removeEventListener('keydown', this.keydownHandler, false)
    }
  },
  methods: {
    exitFocusMode () {
      console.log('[FocusMode] Exit requested')
      this.$store.dispatch('focusMode', false)
    },
    setFenSize () {
      return this.fen.length + 3
    },
    candidateUi (cand) {
      if (cand && cand.ui) return cand.ui
      const share = Math.round(Number((cand && cand.share) || 0) * 100)
      return {
        shareText: `${share}%`,
        practicalText: '실전성 -',
        tag: '실전적',
        confidenceText: '신뢰 보통',
        reason: '기존 오프닝북 가중치를 기반으로 한 추천입니다.',
        cpDeltaText: '-',
        effectiveCpText: '-',
        confidencePercent: '-',
        avgDepthText: '-',
        samplesText: '-',
        cpStdDevText: '-',
        qualityWeightText: '-',
        manualBoostText: '-'
      }
    },
    scroll (event) { // TODO: also moves back and forth when being slightly next to the board and for example over the pockets
      if (event.deltaY < 0) {
        this.moveBackOne()
      } else {
        this.moveForwardOne()
      }
    },
    rightPanelScrollTarget () {
      const visibleTab = this.$el.querySelector('#right-column .tab.visible')
      if (!visibleTab) return null
      const style = window.getComputedStyle(visibleTab)
      const canScrollSelf = /(auto|scroll)/.test(style.overflowY) && visibleTab.scrollHeight > visibleTab.clientHeight
      if (canScrollSelf) return visibleTab
      return visibleTab.querySelector('.analysis, .settings') || visibleTab
    },
    routeWheelToRightPanel (event) {
      const target = event.target
      if (!target || target.closest('.scrollable') || target.closest('#right-column')) return
      if (target.closest('input, textarea, select, button')) return
      const scrollTarget = this.rightPanelScrollTarget()
      if (!scrollTarget || scrollTarget.scrollHeight <= scrollTarget.clientHeight) return
      event.preventDefault()
      scrollTarget.scrollTop += event.deltaY
    },
    moveToStart () { // this method returns to the starting point of the current line
      this.$store.dispatch('fen', this.startFen)
    },
    moveToEnd () { // this method moves to the last move of the current line
      const mov = this.currentMove
      let endOfLine = mov
      if (!mov && this.moves.length === 0) {
        return
      } else if (!mov && this.moves.length > 0) {
        endOfLine = this.mainFirstMove
        while (endOfLine.main) {
          endOfLine = endOfLine.main
        }
      } else {
        endOfLine = mov
        while (endOfLine.main) {
          endOfLine = endOfLine.main
        }
      }
      this.$store.dispatch('fen', endOfLine.fen)
    },
    moveBackOne () { // this method moves back one move in the current line
      const mov = this.currentMove
      if (!mov) {
        return
      }
      if (mov.ply === 1 || !mov.prev) {
        this.$store.dispatch('fen', this.startFen)
        return
      }
      this.$store.dispatch('fen', mov.prev.fen)
    },
    moveForwardOne () { // this method moves forward one move in the current line
      const mov = this.currentMove
      if (!mov) {
        if (this.mainFirstMove) {
          this.$store.dispatch('playAudio', this.mainFirstMove.name)
          this.$store.dispatch('fen', this.mainFirstMove.fen)
        }
        return
      }
      if (!mov.main) {
        return
      }
      this.$store.dispatch('playAudio', mov.main.name)
      this.$store.dispatch('fen', mov.main.fen)
    },
    openNextGame () { // selects the next game, if a pgn with multiple games has been opened
      const selGame = this.$store.getters.selectedGame
      if (selGame) {
        const loadedGames = this.$store.getters.loadedGames
        if (loadedGames.length > (selGame.id + 1)) {
          const nextGame = loadedGames[selGame.id + 1]
          this.$store.dispatch('loadGame', { game: nextGame })
          this.closeThisRoundOpenNext(selGame, nextGame)
        }
      } else { // we just loaded the pgn
        this.$store.dispatch('loadGame', { game: this.$store.getters.loadedGames[0] })
      }
    },
    openPrevGame () { // selects the previous game, if a pgn with multiple games has been opened
      const selGame = this.$store.getters.selectedGame
      if (selGame) {
        const loadedGames = this.$store.getters.loadedGames
        if (selGame.id !== 0) {
          const prevGame = loadedGames[selGame.id - 1]
          this.$store.dispatch('loadGame', { game: prevGame })
          this.closeThisRoundOpenNext(selGame, prevGame)
        }
      } else { // we just loaded the pgn
        const loadedGames = this.$store.getters.loadedGames
        this.$store.dispatch('loadGame', { game: loadedGames[loadedGames.length - 1] })
        // show last round
        this.toggleRoundVisibility(loadedGames[loadedGames.length - 1])
        // hide first round, it is expanded by default
        const firstRound = this.$store.getters.rounds[0]
        firstRound.visible = !firstRound.visible
      }
    },
    closeThisRoundOpenNext (lastGame, nextGame) {
      if (lastGame.headers('Round') !== nextGame.headers('Round') ||
          lastGame.headers('Event') !== nextGame.headers('Event')) {
        this.toggleRoundVisibility(lastGame)
        this.toggleRoundVisibility(nextGame)
      }
    },
    toggleRoundVisibility (game) {
      const rounds = this.$store.getters.rounds
      for (const idx in rounds) {
        const round = rounds[idx]
        if (round.name === game.headers('Round') && round.eventName === game.headers('Event')) {
          round.visible = !round.visible
        }
      }
    },
    flipBoard () {
      if (this.variant === 'racingkings') {
        return
      }
      if (this.orientation === 'white') {
        this.$store.dispatch('orientation', 'black')
      } else {
        this.$store.dispatch('orientation', 'white')
      }
    },
    selectPocketPiece (piece) {
      this.$store.commit('selectPocketPiece', ['boardA', piece.type])
    },
    deselectPocketPieces () {
      this.$store.commit('selectPocketPiece', ['boardA', ''])
    },
    findOpeningProgressive () {
      let mov = this.currentMove
      // check current position
      const opening = findBestOpeningForFen(this.fen)
      if (opening) return opening

      // if no exact match, backtrack
      while (mov && mov.prev) {
        mov = mov.prev
        const opening = findBestOpeningForFen(mov.fen)
        if (opening) return opening
      }

      return null
    },
    getBoardPos (event) {
      if (event.explicitOriginalTarget.className === 'cg-board' && this.selectedPockedPiece.boardA !== '') {
        // get click field
        const x = Math.floor(event.layerX / 40)
        const y = Math.floor(event.layerY / 40)
        // var stringPos = y * 9 + x

        const letters = { 0: 'a', 1: 'b', 2: 'c', 3: 'd', 4: 'e', 5: 'f', 6: 'g', 7: 'h' }
        let pieceCode = Vue.methds.pieceTypeToShort(this.selectedPockedPiece.boardA)
        pieceCode = { type: pieceCode, color: this.turnColor.charAt(0) }
        this.$store.dispatch('insertPieceAtPosition', ['boardA', pieceCode, letters[x] + (8 - y)])
      } else {
        this.deselectPocketPieces()
      }
    },
    showInfo (event) {
      console.log(`showInfo: ${this.fen}`)
      console.log(`fen: ${this.$store.getters.fen}`)
      console.log(`event.history: ${event.history}`)

      if (this.$store.getters.active) {
        this.$store.dispatch('stopEngine')
        this.$store.dispatch('position')
        this.$store.dispatch('goEngine')
      }
      this.tryAutoOpeningResponse()
    },
    addCurrentToOpeningBook () {
      this.$store.dispatch('addCurrentGameToOpeningBook')
      alert('현재 기보를 오프닝북에 추가했습니다.')
    },
    playCandidate (uci) {
      const current = this.currentMove
      this.$store.commit('appendMoves', { move: uci, prev: current })
      this.$store.dispatch('fen', this.$store.getters.board.fen())
      this.$store.dispatch('updateBoard')
      this.$store.dispatch('position')
    },
    removeOpeningCandidate (cand) {
      if (!cand || !cand.uci) return
      if (!confirm('이 수를 오프닝북에서 삭제하시겠습니까?\n[네] [아니요]')) return
      const ok = this.$store.dispatch('deleteOpeningBookMove', {
        parentFen: this.fen,
        move: cand.uci
      })
      Promise.resolve(ok).then((done) => {
        if (!done) alert('삭제할 수를 찾지 못했습니다.')
      })
    },
    async tryAutoOpeningResponse () {
      if (!this.openingBook.enabled || !this.openingBook.autoResponse) return
      if (this.autoReplyBusy) return
      if (!this.openingCandidates || this.openingCandidates.length === 0) return
      this.autoReplyBusy = true
      try {
        await this.$nextTick()
        this.$store.dispatch('playOpeningBookMove')
      } finally {
        setTimeout(() => { this.autoReplyBusy = false }, 120)
      }
    },
    sequencePayload () {
      return {
        variant: this.$store.getters.variant,
        startFen: this.$store.getters.startFen,
        moves: this.$store.getters.currentMainlineUci,
        metadata: {
          exportedAt: new Date().toISOString()
        }
      }
    },
    async copySequence () {
      const text = serializeGameSequence(this.sequencePayload())
      const result = await copyTextReliable(text)
      if (result.ok) {
        alert('전체 대국 수순을 복사했습니다.')
        return
      }
      alert('복사에 실패했습니다. 다른 창을 닫고 다시 시도해 주세요.')
    },
    async copyWinBoardSequence () {
      const text = serializeWinBoardGame({
        fen: this.$store.getters.fen,
        moves: this.$store.getters.currentMainlineUci,
        includeBoardDump: true
      })
      const result = await copyTextReliable(text)
      if (result.ok) {
        alert('WinBoard 전체 대국 수순을 복사했습니다.')
        return
      }
      alert('복사에 실패했습니다. 다른 창을 닫고 다시 시도해 주세요.')
    },
    async copyWinBoardPosition () {
      const text = serializeWinBoardFen(this.$store.getters.fen)
      const result = await copyTextReliable(text)
      if (result.ok) {
        alert('WinBoard 현재 포지션을 복사했습니다.')
        return
      }
      alert('복사에 실패했습니다. 다른 창을 닫고 다시 시도해 주세요.')
    },
    async pasteWinBoardPosition () {
      const read = await readTextReliable()
      if (!read.ok) {
        alert('클립보드를 읽지 못했습니다.')
        return
      }
      const fen = deserializeWinBoardFen(read.text)
      const ok = await this.$store.dispatch('loadWinBoardPosition', fen)
      if (ok) {
        alert('WinBoard 포지션을 불러왔습니다.')
        return
      }
      alert('유효한 WinBoard/Fairy-Stockfish 장기 포지션이 아닙니다.')
    },
    async pasteSequence () {
      const read = await readTextReliable()
      if (!read.ok) {
        alert('클립보드를 읽지 못했습니다.')
        return
      }
      const parsed = parseGameSequence(read.text)
      if (!parsed) {
        alert('지원되는 수순 형식이 아닙니다.')
        return
      }
      await this.$store.dispatch('loadGameSequence', parsed)
      alert(`수순 ${parsed.moves.length}개를 불러왔습니다.`)
    },
    drawArrow (event) {
      console.log(`event: ${event}`)
    },
    checkValidFEN (event) {
      document.dispatchEvent(new Event('resetPlot'))
      this.$store.dispatch('fenField', event.target.value)
      this.resetAnalysis = !this.resetAnalysis
    }
  }
}
</script>

<style scoped>
.main-grid {
  display: grid;
  grid-template-columns: minmax(45%, 1fr) minmax(30%, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  column-gap: 28px;
  height: calc(100vh - 25px);
  overflow: hidden;
  padding-right: 12px;
  grid-template-areas:
    "chessboard analysisview"
    "evalplot analysisview";
}
.chessboard-grid {
  grid-area: chessboard;
  position: sticky;
  top: 0;
  z-index: 2;
  display: grid;
  grid-template-columns: 1fr;
  grid-template-rows: auto auto auto;
  grid-template-areas:
    "board-grid"
    "fenfield"
    "jumpbuttons";
  min-width: 0;
}

.board-grid {
  grid-area: board-grid;
  display: flex;
  flex-direction: row;
  justify-content: center;
}

#gameinfo {
  grid-area: gameinfo;
  border: 1px solid var(--main-border-color);
  margin-bottom: 5px;
  margin-left: 5px;
  border-radius: 5px;
  background-color: var(--second-bg-color);
}
#gameinfo-qt {
  grid-area: gameinfo;
  border: 5px solid var(--quicktour-highlight);
  margin-bottom: 5px;
  margin-left: 5px;
  border-radius: 5px;
  background-color: var(--second-bg-color);
}
#analysisview {
  grid-area: analysisview;
  height: 100%;
  width: 100%;
}
#right-column {
  grid-area: analysisview;
  width: 100%;
  height: 100%;
  min-height: 0;
  max-height: calc(100vh - 25px);
  min-width: 0;
  overflow: hidden;
  padding-left: 16px;
  box-sizing: border-box;
}
.tab:not(.visible) {
  display: none;
}
input {
  font-size: 12pt;
}
#fen-field {
  grid-area: fenfield;
  /*margin-left: 48px;*/
  margin-top: 12px;
}
#fen-field-qt {
  grid-area: fenfield;
  border: 5px solid var(--quicktour-highlight);
  margin-top: 12px;
}
#jump-buttons {
  grid-area: jumpbuttons;
  margin-top: 8px;
}
#jump-buttons-qt {
  grid-area: jumpbuttons;
  margin-top: 8px;
  border: 5px solid var(--quicktour-highlight);
}
#lname {
  background-color: var(--second-bg-color);
  color: var(--main-text-color)
}
.game-sequence-row {
  margin-top: 8px;
  display: flex;
  gap: 8px;
}
.mini-btn {
  font-size: 11px;
  border: 1px solid var(--main-border-color);
  background: var(--second-bg-color);
  color: var(--main-text-color);
}
.opening-candidates {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.opening-candidates-title {
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.candidate-detail-toggle {
  font-size: 10px;
  border: 1px solid var(--main-border-color);
  border-radius: 999px;
  padding: 1px 6px;
  background: var(--second-bg-color);
  color: var(--second-text-color, #9aa0a6);
}
.candidate-card {
  border: 1px solid var(--main-border-color);
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.06);
  overflow: hidden;
}
.candidate-btn {
  width: 100%;
  font-size: 11px;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 3px;
  border: none;
  background: transparent;
  color: var(--main-text-color);
  padding: 5px 6px;
}
.candidate-main {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.candidate-chips, .candidate-debug {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}
.candidate-chip {
  border-radius: 999px;
  padding: 1px 5px;
  background: rgba(114, 137, 218, 0.16);
  color: var(--main-text-color);
}
.candidate-chip.weight {
  background: rgba(114, 137, 218, 0.26);
}
.candidate-chip.practical {
  background: rgba(67, 181, 129, 0.18);
}
.candidate-reason {
  color: var(--second-text-color, #9aa0a6);
  line-height: 1.25;
}
.candidate-debug {
  padding: 4px 6px 5px;
  border-top: 1px solid var(--main-border-color);
  color: var(--second-text-color, #9aa0a6);
  font-size: 10px;
}
#pgnbrowser {
  grid-area: pgnbrowser;
  border: 1px solid var(--main-border-color);
  border-radius: 4px;
  margin-left: 5px;
  max-height: 490px;
}
#pgnbrowser-qt {
  grid-area: pgnbrowser;
  border: 5px solid var(--quicktour-highlight);
  border-radius: 4px;
  margin-left: 1em;
  max-height: 60vh;
}
.scrollable {
  grid-area: scrollable;
  display: flex;
  flex-direction: row;
  justify-content: center;
  width: 100%;
}

.board {
  grid-area: board;
  display: grid;
  column-gap: 12px;
  padding-left: 12px;
  grid-template-areas:
  "gameinfo ."
  "scrollable evalbar";
}
#chessboard {
  display: inline-block;
}
#chessboard-qt {
  display: inline-block;
  border: 5px solid var(--quicktour-highlight);
}
.bottom-margin {
  margin-bottom: 1.5em;
}
#inner {
  display: table;
  margin: 0 auto;
  padding-left: 12px;
}
.evalbar {
  grid-area: evalbar;
  margin-left: 0px;
  padding-right: 0;
  height: auto;
}
.evalbar-qt {
  grid-area: evalbar;
  margin-left: 0px;
  padding-right: 0;
  height: auto;
  border: 3px solid var(--quicktour-highlight);
}
#analysisview {
  margin-left: 0x;
}
#evalplot {
  grid-area: evalplot;
  align-self: start;
  width: 100%;
  max-width: none;
  max-height: 100%;
  margin-top: 12px;
  margin-left: 12px;
  overflow: hidden;
}
#evalplot-qt {
  grid-area: evalplot;
  border: 5px solid var(--quicktour-highlight);
  width: 100%;
  max-width: none;
  margin-top: 12px;
  margin-left: 12px;
}
#evalbutton-style {
  margin-top: 10px;
  grid-area: evalButton;
}

.focus-mode-exit {
  position: fixed;
  top: 14px;
  right: 14px;
  z-index: 1000;
  padding: 8px 12px;
  border: 1px solid #1f6f45;
  border-radius: 6px;
  background: #2f855a;
  color: #fff;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
}

.focus-mode-exit:focus,
.focus-mode-exit:hover {
  background: #276749;
}

.main-grid.focus-mode {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto;
  grid-template-areas: "chessboard";
  justify-items: center;
  align-items: start;
  padding-right: 0;
}
.main-grid.focus-mode .chessboard-grid {
  width: min(96vw, 980px);
}
.main-grid.focus-mode .board {
  grid-template-areas:
    "gameinfo"
    "scrollable";
  justify-items: center;
  row-gap: 10px;
}
.main-grid.focus-mode #fen-field,
.main-grid.focus-mode #fen-field-qt,
.main-grid.focus-mode .game-sequence-row,
.main-grid.focus-mode .opening-candidates {
  display: none;
}

@media (max-width: 1100px) {
  .main-grid {
    grid-template-columns: 1fr;
    grid-template-areas:
      "chessboard"
      "evalplot"
      "analysisview";
  }
  .main-grid {
    height: auto;
    min-height: calc(100vh - 25px);
    overflow: visible;
  }
  .chessboard-grid {
    position: sticky;
    top: 0;
  }
  #right-column {
    height: auto;
    max-height: none;
    overflow: visible;
    padding-left: 0;
  }
}

</style>
<style>
.multiselect {
  color: var(--main-text-color, white) !important;
  background-color: var(--second-bg-color, white) !important;
  border-color: var(--main-border-color, white) !important;
}
.multiselect-qt {
  color: var(--main-text-color, white) !important;
  background-color: var(--second-bg-color, white) !important;
  border-color: var(--quicktour-highlight, white) !important;
}
.multiselect__content ,
.multiselect__content-wrapper,
.multiselect__single,
.multiselect__tags ,
.multiselect__element,
.multiselect__option--selected,
.multiselect__input{
    background-color: var(--second-bg-color, white);
    color: var(--main-text-color);
    border-color: var(--main-border-color);
}
.multiselect ::placeholder {
  color: var(--main-text-color) !important;
  opacity: 0.5;
}
.multiselect__select {
  border-radius: 5px;
  right: 2px;
  top: 2px;
  height: 36px;
}

.v-table-header-wrap *,
.v-table-body * {
  background-color: var(--second-bg-color, white) !important;
  color: var(--main-text-color, black) !important;
  border-color: var(--main-border-color, white) !important;
}
.v-table-dynamic * ,
.v-table:before{
  border-color: var(--main-border-color, white) !important;
}
::-webkit-scrollbar {
  width: 15px;
  height: 15px;
}
::-webkit-scrollbar-track{
  background: var(--scroll-track-color);
}
::-webkit-scrollbar-thumb {
  background: var(--scroll-thumb-color);
  border-radius: 8px;
}
::-webkit-scrollbar-corner {
  background: var(--main-bg-color);
  border-radius: 8px;
}

.opening-label {
  margin-top: 4px;
  font-size: 11pt;
  color: var(--main-text-color);
  opacity: 0.9;
}

.opening-label-qt {
  margin-top: 4px;
  font-size: 11pt;
  color: var(--main-text-color);
  opacity: 0.9;
  border: 5px solid var(--quicktour-highlight);
  padding: 2px 4px;
  border-radius: 4px;
}

</style>
