<template>
  <section class="mistake-panel">
    <div class="mistake-header">
      <div>
        <h3>실수방지 모드</h3>
        <small>Mistake Prevention Mode</small>
      </div>
      <label class="toggle"><input :checked="settings.enabled" type="checkbox" @change="update({ enabled: $event.target.checked })"> Enable</label>
    </div>
    <div class="mistake-controls">
      <label>Training level
        <select :value="settings.levelName" @change="update({ levelName: $event.target.value })">
          <option v-for="level in levels" :key="level.name" :value="level.name">{{ level.name }} · {{ level.thresholdCp }}cp ({{ points(level.thresholdCp) }} points)</option>
        </select>
      </label>
      <label><input :checked="settings.opponentTraining" type="checkbox" @change="update({ opponentTraining: $event.target.checked })"> Opponent training strength</label>
      <label v-if="settings.opponentTraining">Opponent level
        <select :value="settings.opponentLevelName || settings.levelName" @change="update({ opponentLevelName: $event.target.value })">
          <option v-for="level in levels" :key="level.name" :value="level.name">{{ level.name }} · max {{ level.thresholdCp }}cp</option>
        </select>
      </label>
      <span v-if="pending" class="pending">Coach is checking the move…</span>
    </div>
    <div v-if="latest" class="lesson" :class="latest.moveQualityColor">
      <strong>Rejected lesson</strong>
      <div>My move: <code>{{ latest.userMove }}</code> · Engine move: <code>{{ latest.engineBestMove }}</code></div>
      <div>Evaluation: {{ evalText(latest.evaluationBefore) }} → {{ evalText(latest.evaluationAfter) }}</div>
      <div>Loss: <b>{{ latest.cpLoss }}cp</b> · <b>{{ latest.pointLoss.toFixed(1) }} points</b></div>
      <div v-if="latest.pv">PV: <code>{{ latest.pv }}</code></div>
      <div v-if="latest.opponentBestResponse">Opponent best response: <code>{{ latest.opponentBestResponse }}</code></div>
    </div>
    <div class="stats">
      <b>Statistics</b><span>Total {{ stats.totalMistakes }}</span><span>Avg {{ stats.averageCpLoss }}cp / {{ points(stats.averageCpLoss) }} points</span><span>Largest {{ stats.largestMistake }}cp / {{ points(stats.largestMistake) }} points</span><span>Trend {{ stats.improvementOverTime }}cp</span>
    </div>
    <div class="piece-stats"><span v-for="row in pieceRows" :key="row.piece">{{ row.piece }} {{ row.percent }}%</span></div>
    <details class="notebook" open>
      <summary>실수 노트 / Mistake Notebook ({{ notebook.length }})</summary>
      <button class="clear" @click="clearNotebook">Clear notebook</button>
      <article v-for="entry in notebook.slice(0, 25)" :key="entry.id" class="entry" :class="entry.moveQualityColor">
        <header>{{ entry.timestamp }} · {{ entry.pattern }} · {{ entry.pieceType }}</header>
        <div><code>{{ entry.userMove }}</code> rejected; best <code>{{ entry.engineBestMove }}</code></div>
        <div>{{ entry.cpLoss }}cp / {{ entry.pointLoss.toFixed(1) }} points · {{ evalText(entry.evaluationBefore) }} → {{ evalText(entry.evaluationAfter) }}</div>
        <small>{{ entry.position }}</small>
      </article>
    </details>
  </section>
</template>
<script>
import { mapGetters } from 'vuex'
export default {
  name: 'MistakeNotebook',
  computed: {
    ...mapGetters(['mistakePrevention', 'mistakePreventionLevels', 'mistakeNotebook', 'mistakeStatistics', 'mistakePreventionPending']),
    settings () { return this.mistakePrevention || {} },
    levels () { return this.mistakePreventionLevels || [] },
    notebook () { return this.mistakeNotebook || [] },
    stats () { return this.mistakeStatistics || {} },
    pending () { return this.mistakePreventionPending },
    latest () { return this.notebook[0] },
    pieceRows () {
      const total = Math.max(1, this.stats.totalMistakes || 0)
      return Object.entries(this.stats.mistakesByPieceType || {}).map(([piece, count]) => ({ piece, percent: Math.round(count * 100 / total) }))
    }
  },
  methods: {
    update (payload) { this.$store.dispatch('setMistakePreventionSettings', payload) },
    clearNotebook () { if (confirm('Clear the mistake notebook?')) this.$store.dispatch('clearMistakeNotebook') },
    points (cp) { return ((Number(cp) || 0) / 100).toFixed(1) },
    evalText (cp) {
      if (cp === null || cp === undefined) return '?'
      const v = (Number(cp) / 100).toFixed(2)
      return Number(cp) > 0 ? `+${v}` : v
    }
  }
}

</script>
<style scoped>
.mistake-panel { margin: 12px 0; padding: 12px; border-radius: 8px; background: rgba(127,127,127,.12); text-align: left; }
.mistake-header, .mistake-controls, .stats, .piece-stats { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.mistake-header { justify-content: space-between; }
h3 { margin: 0; }
select { margin-left: 6px; }
.pending { color: #c28500; font-weight: bold; }
.lesson, .entry { border-left: 5px solid #888; margin: 8px 0; padding: 8px; background: rgba(0,0,0,.06); }
.red { border-left-color: #d33; } .orange { border-left-color: #f80; } .yellow { border-left-color: #ddc000; } .blue { border-left-color: #36c; } .green { border-left-color: #2a2; }
.stats span, .piece-stats span { padding: 3px 6px; border-radius: 10px; background: rgba(127,127,127,.16); }
.clear { margin: 6px 0; }
.entry small { display: block; word-break: break-all; opacity: .7; }
code { white-space: pre-wrap; }
</style>
