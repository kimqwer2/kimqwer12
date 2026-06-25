<template>
  <section class="mistake-panel">
    <div class="mistake-header">
      <div>
        <h3>실수방지 모드</h3>
        <small>엔진 기준 실수 자동 교정</small>
      </div>
      <label class="toggle"><input :checked="settings.enabled" type="checkbox" @change="update({ enabled: $event.target.checked })"> 사용</label>
    </div>
    <div class="mistake-controls">
      <label>학습 난이도
        <select :value="settings.levelName" @change="update({ levelName: $event.target.value })">
          <option v-for="level in levels" :key="level.name" :value="level.name">{{ level.name }} · {{ level.thresholdCp }}CP ({{ points(level.thresholdCp) }}점)</option>
        </select>
      </label>
      <label>실수 판정 방식
        <select :value="settings.evaluationMode || 'practical'" @change="update({ evaluationMode: $event.target.value })">
          <option value="perfect">엄격</option>
          <option value="flexible">실전적</option>
          <option value="practical">관대함</option>
        </select>
      </label>
      <label>실수 검증 깊이
        <select :value="settings.verificationDepth || 14" @change="update({ verificationDepth: Number($event.target.value) })">
          <option v-for="depth in verificationDepths" :key="depth" :value="depth">{{ depth }}</option>
        </select>
      </label>
      <label><input :checked="settings.opponentTraining" type="checkbox" @change="update({ opponentTraining: $event.target.checked })"> 상대 난이도</label>
      <label v-if="settings.opponentTraining">상대 수준
        <select :value="settings.opponentLevelName || settings.levelName" @change="update({ opponentLevelName: $event.target.value })">
          <option v-for="level in levels" :key="level.name" :value="level.name">{{ level.name }} · 최대 {{ level.thresholdCp }}CP</option>
        </select>
      </label>
      <label v-if="settings.opponentTraining">Chaos 모드
        <select :value="settings.chaosMode || (settings.chaosTraining ? 'search' : 'off')" @change="update({ chaosMode: $event.target.value })">
          <option value="off">Off</option>
          <option value="fast">Chaos Fast</option>
          <option value="search">Chaos Search</option>
        </select>
      </label>
      <label v-if="settings.opponentTraining"><input :checked="settings.opponentPreventionMode === 'perfect'" type="checkbox" @change="update({ opponentPreventionMode: $event.target.checked ? 'perfect' : 'off' })"> 엔진 최선수 강제</label>
      <label v-if="settings.opponentTraining && settings.opponentPreventionMode !== 'perfect'">상대 스타일 (일반 모드)
        <select :value="settings.opponentPreventionMode || 'off'" @change="update({ opponentPreventionMode: $event.target.value })">
          <option value="off">난이도만 적용 · CP 샘플링</option>
          <option value="flexible">실전형 · 좋은 평가 유지</option>
          <option value="practical">유연형 · 넓은 실전 허용폭</option>
        </select>
      </label>
      <small v-if="settings.opponentTraining" class="mode-help">엔진 최선수 강제는 상대 수준을 무시하고 최선수를 둡니다. 스타일은 CP 난이도는 유지하면서 비최선수 허용 방식을 조절합니다.</small>
      <fieldset v-if="settings.opponentTraining" class="opening-stabilizer">
        <legend>Opening Stabilizer</legend>
        <label><input :checked="openingStabilizer.enabled !== false" type="checkbox" @change="updateOpeningStabilizer({ enabled: $event.target.checked })"> ON</label>
        <label>Phase 1 Moves <input class="small-input" :value="openingStabilizer.phase1Moves" min="0" max="60" type="number" @change="updateOpeningStabilizer({ phase1Moves: Number($event.target.value) })"></label>
        <label>Phase 1 CP <input class="small-input" :value="openingStabilizer.phase1Cp" min="0" max="1000" type="number" @change="updateOpeningStabilizer({ phase1Cp: Number($event.target.value) })"></label>
        <label>Phase 2 Moves <input class="small-input" :value="openingStabilizer.phase2Moves" min="0" max="80" type="number" @change="updateOpeningStabilizer({ phase2Moves: Number($event.target.value) })"></label>
        <label>Phase 2 CP <input class="small-input" :value="openingStabilizer.phase2Cp" min="0" max="1000" type="number" @change="updateOpeningStabilizer({ phase2Cp: Number($event.target.value) })"></label>
        <label>Phase 3 Moves <input class="small-input" :value="openingStabilizer.phase3Moves" min="0" max="120" type="number" @change="updateOpeningStabilizer({ phase3Moves: Number($event.target.value) })"></label>
        <small class="mode-help">초반에는 MultiPV 후보 중 CP 손실이 큰 수만 제외하고, 추가 엔진 검색은 하지 않습니다.</small>
      </fieldset>
      <template v-if="settings.opponentTraining && (settings.chaosMode || (settings.chaosTraining ? 'search' : 'off')) !== 'off'">
        <label>카오스 검증
          <select :value="chaosValidation.preset" @change="updateChaosPreset($event.target.value)">
            <option v-for="preset in chaosValidationPresets" :key="preset.name" :value="preset.name">{{ preset.name }} · {{ preset.stage1Depth }}/{{ preset.stage2Depth }}</option>
          </select>
        </label>
        <label>1차 검증 깊이 <input class="small-input" :value="chaosValidation.stage1Depth" min="1" max="20" type="number" @change="updateChaosValidation({ stage1Depth: Number($event.target.value) })"></label>
        <label>2차 검증 깊이 <input class="small-input" :value="chaosValidation.stage2Depth" min="1" max="24" type="number" @change="updateChaosValidation({ stage2Depth: Number($event.target.value) })"></label>
        <label>최대 시도 횟수 <input class="small-input" :value="chaosValidation.maxAttempts" min="1" max="80" type="number" @change="updateChaosValidation({ maxAttempts: Number($event.target.value) })"></label>
      </template>
      <span v-if="pending" class="pending">코치가 수를 확인 중…</span>
    </div>
    <div v-if="latest" class="lesson" :class="latest.moveQualityColor" @mouseenter="previewEntry(latest)" @mouseleave="clearPreview">
      <strong>{{ latest.reviewMove && latest.reviewMove.classificationLabel ? latest.reviewMove.classificationLabel : '거절된 수' }}</strong>
      <div>내가 둔 수: <code>{{ latest.userMove }}</code> · 엔진 추천 수: <code>{{ latest.engineBestMove }}</code></div>
      <div>평가치: {{ evalText(latest.evaluationBefore) }} → {{ evalText(latest.evaluationAfter) }}</div>
      <div>손해: <b>{{ latest.cpLoss }}CP</b> · <b>{{ latest.pointLoss.toFixed(1) }}점</b><span v-if="latest.rawCpLoss !== latest.cpLoss"> · 원본 {{ latest.rawCpLoss }}CP</span></div>
      <div>판정 방식: {{ modeLabel(latest.evaluationMode) }} · 깊이 {{ latest.verificationDepth || '?' }}</div>
      <div v-if="latest.pv">PV: <code>{{ latest.pv }}</code></div>
      <button v-if="latest.responseReviewMove" class="preview-btn" @mouseenter.stop="previewResponse(latest)" @mouseleave.stop="previewEntry(latest)">상대 예상 응수: {{ latest.opponentBestResponse }}</button>
    </div>
    <div class="stats">
      <b>통계</b><span>전체 {{ stats.totalMistakes }}</span><span>평균 {{ stats.averageCpLoss }}CP / {{ points(stats.averageCpLoss) }}점</span><span>최대 {{ stats.largestMistake }}CP / {{ points(stats.largestMistake) }}점</span><span>추세 {{ stats.improvementOverTime }}CP</span>
    </div>
    <div class="piece-stats"><span v-for="row in pieceRows" :key="row.piece">{{ row.piece }} {{ row.percent }}%</span></div>
    <details class="notebook" open>
      <summary>실수 노트 ({{ notebook.length }})</summary>
      <button class="clear" @click="clearNotebook">노트 비우기</button>
      <button class="clear" @click="toggleAllEntries">{{ allEntriesExpanded ? '전체 접기' : '전체 펼치기' }}</button>
      <div class="compact-list">
        <article v-for="entry in notebook.slice(0, 25)" :key="entry.id" class="entry review-move compact-entry" :class="[entry.moveQualityColor, { expanded: isEntryExpanded(entry) }]" @mouseenter="previewEntry(entry)" @mouseleave="clearPreview" @click="toggleEntry(entry)">
          <header><span class="entry-icon">{{ entryIcon(entry) }}</span><b>{{ entry.userMove }}</b><span>{{ entry.cpLoss }}CP</span><small>{{ entry.pieceType }}</small></header>
          <div class="compact-line">추천 <code>{{ entry.engineBestMove }}</code> · {{ evalText(entry.evaluationBefore) }} → {{ evalText(entry.evaluationAfter) }}</div>
          <template v-if="isEntryExpanded(entry)">
            <div>{{ entry.reviewMove && entry.reviewMove.classificationLabel ? entry.reviewMove.classificationLabel : entry.pattern }} · {{ entry.timestamp }}</div>
            <div><code>{{ entry.userMove }}</code> 거절 · 추천 <code>{{ entry.engineBestMove }}</code></div>
            <div>{{ entry.cpLoss }}CP / {{ entry.pointLoss.toFixed(1) }}점 · {{ evalText(entry.evaluationBefore) }} → {{ evalText(entry.evaluationAfter) }}</div>
            <button v-if="entry.responseReviewMove" class="preview-btn" @click.stop @mouseenter.stop="previewResponse(entry)" @mouseleave.stop="previewEntry(entry)">상대 예상 응수 {{ entry.opponentBestResponse }}</button>
            <small>{{ entry.position }}</small>
          </template>
        </article>
      </div>
    </details>
  </section>
</template>
<script>
import { mapGetters } from 'vuex'
export default {
  name: 'MistakeNotebook',
  data () {
    return { verificationDepths: [10, 12, 14, 16, 18, 20], expandedEntries: {}, allEntriesExpanded: false }
  },
  beforeDestroy () {
    this.clearPreview()
  },
  computed: {
    ...mapGetters(['mistakePrevention', 'mistakePreventionLevels', 'chaosValidationPresets', 'mistakeNotebook', 'mistakeStatistics', 'mistakePreventionPending']),
    settings () { return this.mistakePrevention || {} },
    chaosValidation () { return this.settings.chaosValidation || { preset: 'Normal', stage1Depth: 4, stage2Depth: 10, maxAttempts: 24 } },
    openingStabilizer () { return this.settings.openingStabilizer || { enabled: true, phase1Moves: 5, phase1Cp: 25, phase2Moves: 10, phase2Cp: 75, phase3Moves: 20 } },
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
    updateOpeningStabilizer (payload) { this.update({ openingStabilizer: { ...this.openingStabilizer, ...payload } }) },
    updateChaosValidation (payload) { this.update({ chaosValidation: { ...this.chaosValidation, ...payload } }) },
    updateChaosPreset (name) {
      const preset = (this.chaosValidationPresets || []).find(p => p.name === name)
      this.updateChaosValidation(preset ? { preset: preset.name, stage1Depth: preset.stage1Depth, stage2Depth: preset.stage2Depth } : { preset: name })
    },
    clearNotebook () { if (confirm('실수 노트를 비울까요?')) this.$store.dispatch('clearMistakeNotebook') },
    previewEntry (entry) {
      if (entry && entry.reviewMove && entry.reviewMove.previewFen) this.$store.dispatch('previewReviewMove', entry.reviewMove)
    },
    previewResponse (entry) {
      if (entry && entry.responseReviewMove && entry.responseReviewMove.previewFen) this.$store.dispatch('previewReviewMove', entry.responseReviewMove)
    },
    clearPreview () { this.$store.dispatch('clearReviewPreview') },
    points (cp) { return ((Number(cp) || 0) / 100).toFixed(1) },
    modeLabel (mode) { return mode === 'perfect' ? '엄격' : (mode === 'flexible' ? '실전적' : '관대함') },
    entryKey (entry) { return entry.id || `${entry.timestamp}-${entry.userMove}` },
    isEntryExpanded (entry) { return this.allEntriesExpanded || !!this.expandedEntries[this.entryKey(entry)] },
    toggleEntry (entry) { this.$set(this.expandedEntries, this.entryKey(entry), !this.isEntryExpanded(entry)) },
    toggleAllEntries () { this.allEntriesExpanded = !this.allEntriesExpanded; if (!this.allEntriesExpanded) this.expandedEntries = {} },
    entryIcon (entry) { return entry.cpLoss >= 300 ? '!!' : (entry.cpLoss >= 150 ? '!' : '•') },
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
.small-input { width: 58px; margin-left: 6px; }
.mode-help { flex-basis: 100%; opacity: .75; }
.pending { color: #c28500; font-weight: bold; }
.lesson, .entry { border-left: 5px solid #888; margin: 8px 0; padding: 8px; background: rgba(0,0,0,.06); }
.review-move:hover, .lesson:hover { outline: 2px solid rgba(114, 137, 218, .55); cursor: pointer; }
.red { border-left-color: #d33; } .orange { border-left-color: #f80; } .yellow { border-left-color: #ddc000; } .blue { border-left-color: #36c; } .green { border-left-color: #2a2; }
.stats span, .piece-stats span { padding: 3px 6px; border-radius: 10px; background: rgba(127,127,127,.16); }
.preview-btn, .clear { margin: 6px 0; }
.entry small { display: block; word-break: break-all; opacity: .7; }
.compact-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 6px; }
.compact-entry { margin: 0; padding: 6px; min-height: 44px; }
.compact-entry header { display: flex; gap: 6px; align-items: center; justify-content: space-between; }
.entry-icon { font-weight: bold; min-width: 18px; }
.compact-line { font-size: 12px; opacity: .85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.compact-entry.expanded { grid-column: 1 / -1; }
code { white-space: pre-wrap; }
</style>
