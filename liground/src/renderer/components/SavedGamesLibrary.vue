<template>
  <section class="saved-games panel">
    <header class="saved-games-header">
      <div>
        <h3>Saved Games</h3>
        <p>Local study library{{ directoryLabel }}</p>
      </div>
      <button type="button" class="small" :disabled="loading" @click="refresh">Refresh</button>
    </header>

    <div class="library-actions">
      <input
        v-model="gameName"
        type="text"
        placeholder="Game name"
        @keyup.enter="saveCurrentGame"
      >
      <button type="button" class="primary" :disabled="loading" @click="saveCurrentGame">Save current game</button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <details v-if="recentGames.length" open class="saved-group">
      <summary>Recent Games</summary>
      <div class="saved-list compact">
        <button
          v-for="game in recentGames"
          :key="`recent-${game.filePath}`"
          type="button"
          :class="['saved-row', { selected: selected && selected.filePath === game.filePath }]"
          @click="selected = game"
          @dblclick="loadGame(game)"
        >
          <span class="title">{{ game.name }}</span>
          <span>{{ formatDate(game.savedAt || game.updatedAt) }}</span>
        </button>
      </div>
    </details>

    <div class="saved-list">
      <button
        v-for="game in games"
        :key="game.filePath"
        type="button"
        :class="['saved-row', { selected: selected && selected.filePath === game.filePath }]"
        @click="selected = game"
        @dblclick="loadGame(game)"
      >
        <span class="title">{{ game.name }}</span>
        <span>{{ formatDate(game.savedAt || game.updatedAt) }}</span>
        <span>{{ game.moveCount }} moves</span>
        <span>{{ game.result || '*' }}</span>
      </button>
      <p v-if="!loading && !games.length" class="empty">No saved games yet.</p>
    </div>

    <footer class="selected-actions">
      <button type="button" :disabled="!selected || loading" @click="loadGame(selected)">Load</button>
      <button type="button" :disabled="!selected || loading" @click="renameGame">Rename</button>
      <button type="button" :disabled="!selected || loading" @click="deleteGame">Delete</button>
      <button type="button" :disabled="!selected || loading" @click="exportTxt">Export TXT</button>
    </footer>
  </section>
</template>

<script>
import { serializeGameSequence } from '../../shared/gameSequence'

export default {
  name: 'SavedGamesLibrary',
  data () {
    return {
      games: [],
      selected: null,
      loading: false,
      error: '',
      directory: '',
      gameName: '',
      refreshHandler: null
    }
  },
  computed: {
    recentGames () {
      return this.games.slice(0, 5)
    },
    directoryLabel () {
      return this.directory ? ` · ${this.directory}` : ''
    }
  },
  mounted () {
    this.refreshHandler = () => this.refresh()
    document.addEventListener('liground-saved-games-refresh', this.refreshHandler)
    this.refresh()
  },
  beforeDestroy () {
    if (this.refreshHandler) document.removeEventListener('liground-saved-games-refresh', this.refreshHandler)
  },
  methods: {
    ipc () {
      return require('electron').ipcRenderer
    },
    async refresh () {
      this.loading = true
      this.error = ''
      try {
        const result = await this.ipc().invoke('saved-games-library-list')
        if (!result.success) throw new Error(result.error || 'Could not load saved games')
        this.games = result.games || []
        this.directory = result.directory || ''
        if (this.selected) {
          this.selected = this.games.find(game => game.filePath === this.selected.filePath) || null
        }
      } catch (error) {
        this.error = error.message
      } finally {
        this.loading = false
      }
    },
    snapshotWithName (name) {
      const snapshot = JSON.parse(JSON.stringify(this.$store.getters.savedGameSnapshot || {}))
      const now = new Date().toISOString()
      snapshot.metadata = {
        ...(snapshot.metadata || {}),
        name: name || (snapshot.metadata && snapshot.metadata.name) || 'Untitled Game',
        savedAt: now,
        updatedAt: now,
        result: (snapshot.metadata && snapshot.metadata.result) || '*',
        moveCount: Array.isArray(snapshot.moves) ? snapshot.moves.length : 0
      }
      return snapshot
    },
    async saveCurrentGame () {
      this.loading = true
      this.error = ''
      try {
        const name = this.gameName.trim() || `Saved Game ${new Date().toLocaleString()}`
        const result = await this.ipc().invoke('saved-games-library-save', this.snapshotWithName(name))
        if (!result.success) throw new Error(result.error || 'Could not save game')
        this.gameName = ''
        await this.refresh()
        document.dispatchEvent(new CustomEvent('liground-saved-games-refresh'))
        this.selected = this.games.find(game => result.game && game.filePath === result.game.filePath) || this.games[0] || null
      } catch (error) {
        this.error = error.message
      } finally {
        this.loading = false
      }
    },
    async readGame (game) {
      const result = await this.ipc().invoke('saved-games-library-read', game.filePath)
      if (!result.success) throw new Error(result.error || 'Could not read game')
      return result.game
    },
    async loadGame (game) {
      if (!game) return
      this.loading = true
      this.error = ''
      try {
        const saved = await this.readGame(game)
        await this.$store.dispatch('loadGameSequence', {
          variant: saved.variant,
          startFen: saved.startFen,
          moves: saved.moves || [],
          comments: saved.comments || {},
          gameInfo: saved.gameInfo || saved.metadata || {},
          review: saved.analysis && saved.analysis.review ? saved.analysis.review : saved.review
        })
        this.selected = game
      } catch (error) {
        this.error = error.message
      } finally {
        this.loading = false
      }
    },
    async renameGame () {
      if (!this.selected) return
      const name = prompt('New game name', this.selected.name)
      if (!name || !name.trim()) return
      this.loading = true
      try {
        const result = await this.ipc().invoke('saved-games-library-rename', { filePath: this.selected.filePath, name: name.trim() })
        if (!result.success) throw new Error(result.error || 'Could not rename game')
        await this.refresh()
        this.selected = this.games.find(game => game.filePath === result.game.filePath) || null
      } catch (error) {
        this.error = error.message
      } finally {
        this.loading = false
      }
    },
    async deleteGame () {
      if (!this.selected) return
      if (!confirm(`Delete "${this.selected.name}" from the saved games library?`)) return
      this.loading = true
      try {
        const filePath = this.selected.filePath
        const result = await this.ipc().invoke('saved-games-library-delete', filePath)
        if (!result.success) throw new Error(result.error || 'Could not delete game')
        this.selected = null
        await this.refresh()
      } catch (error) {
        this.error = error.message
      } finally {
        this.loading = false
      }
    },
    async exportTxt () {
      if (!this.selected) return
      this.loading = true
      try {
        const saved = await this.readGame(this.selected)
        const content = serializeGameSequence({
          variant: saved.variant,
          startFen: saved.startFen,
          moves: saved.moves || [],
          metadata: saved.metadata || {}
        })
        const dialog = await this.ipc().invoke('show-save-dialog', {
          title: 'Export Saved Game',
          defaultPath: `${this.selected.name || 'saved-game'}.txt`,
          filters: [{ name: 'Text Files', extensions: ['txt'] }, { name: 'All Files', extensions: ['*'] }]
        })
        if (dialog.canceled || !dialog.filePath) return
        const write = await this.ipc().invoke('write-file', dialog.filePath, content)
        if (!write.success) throw new Error(write.error || 'Could not export game')
      } catch (error) {
        this.error = error.message
      } finally {
        this.loading = false
      }
    },
    formatDate (value) {
      if (!value) return 'Unknown date'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      return date.toLocaleString()
    }
  }
}
</script>

<style scoped>
.saved-games {
  margin: 10px 0;
  padding: 10px;
  border: 1px solid var(--main-border-color);
  border-radius: 6px;
  background: var(--second-bg-color);
  color: var(--main-text-color);
  font-size: 12px;
}
.saved-games-header {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: flex-start;
}
h3, p { margin: 0; }
.saved-games-header p,
.empty { color: var(--second-text-color, #9aa0a6); }
.library-actions,
.selected-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.library-actions input {
  flex: 1 1 180px;
  min-width: 0;
  padding: 5px;
  border: 1px solid var(--main-border-color);
  border-radius: 4px;
  background: var(--button-color);
  color: var(--main-text-color);
}
button {
  border: 1px solid var(--main-border-color);
  border-radius: 4px;
  padding: 5px 8px;
  background: var(--button-color);
  color: var(--main-text-color);
  cursor: pointer;
}
button:disabled { opacity: 0.45; cursor: not-allowed; }
button.primary { background: #7289da; color: #fff; }
.saved-group { margin-top: 8px; }
.saved-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 260px;
  margin-top: 8px;
  overflow-y: auto;
}
.saved-list.compact { max-height: 120px; }
.saved-row {
  display: grid;
  grid-template-columns: minmax(90px, 1fr) auto auto auto;
  gap: 6px;
  width: 100%;
  text-align: left;
}
.saved-list.compact .saved-row { grid-template-columns: minmax(90px, 1fr) auto; }
.saved-row.selected {
  outline: 2px solid #7289da;
}
.title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 800;
}
.error {
  margin-top: 8px;
  color: #ff8f8f;
}
</style>
