<template>
  <div class="viz-settings">
    <div class="section-head" @click="toggleSection('visualization')"><span>{{ sectionArrow('visualization') }}</span> Visualization</div>
    <template v-if="expandedSections.visualization">
    <label><input v-model="local.showMultiPvArrows" type="checkbox" @change="save"> 후보수 화살표</label>
    <label><input v-model="humanTrapMode" type="checkbox"> Human Trap Mode</label>
    <label><input v-model="closeWinMode" type="checkbox"> Controlled Margin Mode</label>
    <small>Human Trap은 분석/추천/엔진 선택에 실전 함정 압력을 반영합니다. Controlled Margin은 작은 목표 우세권(+0.7~+1.3) 안에서 승리 마진을 조절합니다. Pressure/Hunter/Closer는 실수방지 모드 패널로 이동했습니다.</small>
    <label>표시 후보 수 <input v-model.number="local.multiPvCount" min="1" type="number" @change="save"></label>
    <label><input v-model="local.trajectoryEnabled" type="checkbox" @change="save"> 최선 수순 궤적</label>
    <label>표시 방향
      <select v-model="local.trajectorySideMode" @change="save"><option value="both">양쪽</option><option value="my">내 수</option></select>
    </label>
    <label>궤적 깊이
      <select v-model="depthMode" @change="saveDepth"><option value="4">4</option><option value="8">8</option><option value="12">12</option><option value="20">20</option><option value="40">40</option><option value="unlimited">무제한</option></select>
    </label>
    <label>표시 방식
      <select v-model="local.visualizationMode" @change="save"><option value="arrow">화살표</option><option value="ghost">잔상 궤적</option><option value="hybrid">혼합</option></select>
    </label>
    <label><input v-model="local.orderNumbers" type="checkbox" @change="save"> 순번 표시</label>
    <label><input v-model="local.orderThickness" type="checkbox" @change="save"> 두께 반영</label>
    <label><input v-model="local.orderOpacity" type="checkbox" @change="save"> 투명도 반영</label>

    <label>분석 목표 깊이
      <select v-model="targetDepth" @change="saveTarget"><option value="infinite">무제한</option><option value="10">10</option><option value="15">15</option><option value="20">20</option><option value="25">25</option><option value="30">30</option><option value="35">35</option><option value="40">40</option></select>
    </label>

    <details class="deep-advanced">
      <summary>수순 리뷰 깊이</summary>
      <label>프리셋
        <select v-model="local.reviewDepthPreset" @change="applyReviewPreset">
          <option value="fast">빠르게</option>
          <option value="normal">보통</option>
          <option value="deep">깊게</option>
          <option value="expert">전문가</option>
        </select>
      </label>
      <label>리뷰 깊이 <input v-model.number="local.reviewDepth" min="6" max="32" type="number" @change="save"></label>
      <label>전술 확인 깊이 <input v-model.number="local.reviewTacticalDepth" min="4" max="32" type="number" @change="save"></label>
      <label>전략 수순 범위 <input v-model.number="local.reviewStrategicHorizon" min="1" max="60" type="number" @change="save"></label>
      <label>응징 수순 길이 <input v-model.number="local.reviewPunishmentLineLength" min="2" max="12" type="number" @change="save"></label>
      <label>해설 밀도
        <select v-model="local.reviewDetailLevel" @change="save">
          <option value="compact">간결</option>
          <option value="balanced">균형</option>
          <option value="verbose">상세</option>
        </select>
      </label>
      <label><input v-model="local.realtimeGameCommentary" type="checkbox" @change="save"> 실시간 전략 해설</label>
      <label><input v-model="local.realtimeCommentaryArrows" type="checkbox" @change="save"> 실시간 전략 화살표 표시</label>
      <small>켜면 임시 수순이나 현재 기보 흐름이 잠시 멈춘 뒤 자동으로 엔진 리뷰를 반영합니다. 화살표 옵션은 실시간 전략 해설이 만든 표시만 조절하며 일반 엔진/수순 리뷰 표시는 유지됩니다.</small>
      <small>깊게/전문가 모드는 느리지만 지연 전술, 장기 압박, 응징 수순을 더 오래 추적합니다.</small>
    </details>
    </template>

    <div class="deep-box">
      <h4>분석 모드</h4>
      <label class="radio-row"><input v-model="local.analysisModeType" type="radio" value="normal" @change="save"> 일반 분석</label>
      <label class="radio-row"><input v-model="local.analysisModeType" type="radio" value="deep" @change="save"> 심층 분석</label>
      <small>심층 분석은 후보수를 먼저 넓게 확보한 뒤, 각 후보를 독립된 수순처럼 다시 검토해 편향과 불안정성을 줄이는 감독 모드입니다.</small>

      <template v-if="local.analysisModeType === 'deep'">
        <button type="button" :disabled="deepAnalysis.running" @click="startDeepAnalysis">
          {{ deepAnalysis.running ? '심층 분석 진행 중…' : '심층 분석 실행' }}
        </button>
        <details class="deep-advanced">
          <summary>심층 분석 세부 설정</summary>
          <label>후보수 개수 <input v-model.number="local.deepCandidateCount" min="1" max="8" type="number" @change="save"></label>
          <label>초기 후보 탐색(초) <input :value="msToSec(local.deepRootTimeMs)" min="1" type="number" @change="saveMs('deepRootTimeMs', $event.target.value)"></label>
          <label>후보별 분석 시간(초) <input :value="msToSec(local.deepTimePerCandidateMs)" min="1" type="number" @change="saveMs('deepTimePerCandidateMs', $event.target.value)"></label>
          <label>보조 후보 분석(초) <input :value="msToSec(local.deepSecondaryTimeMs)" min="1" type="number" @change="saveMs('deepSecondaryTimeMs', $event.target.value)"></label>
          <label>후보별 깊이 <input v-model.number="local.deepDepthPerCandidate" min="0" type="number" @change="save"></label>
          <label>시간 배분
            <select v-model="local.deepScheduleMode" @change="save">
              <option value="equal">동일 시간</option>
              <option value="top-short-secondary-long">1순위 짧게 / 대안 길게</option>
              <option value="dynamic-instability">불안정도 기반 동적 배분</option>
            </select>
          </label>
          <label><input v-model="local.deepClearHashBetweenCandidates" type="checkbox" @change="save"> 후보 사이 해시 초기화</label>
          <label>불안정 민감도(cp) <input v-model.number="local.deepInstabilitySensitivityCp" min="20" type="number" @change="save"></label>
          <label>다양성 기준 <input v-model.number="local.deepDiversityThreshold" min="1" type="number" @change="save"></label>
          <label>후보 최대 시간(초) <input :value="msToSec(local.deepMaxDurationMs)" min="5" type="number" @change="saveMs('deepMaxDurationMs', $event.target.value)"></label>
        </details>
      </template>
    </div>

    <div class="deep-box">
      <div class="section-head" @click="toggleSection('openingBook')"><span>{{ sectionArrow('openingBook') }}</span> Opening Book <b>[{{ openingBookLocal.enabled ? 'ON' : 'OFF' }}]</b> <label class="inline-toggle" @click.stop><input v-model="openingBookLocal.enabled" type="checkbox" @change="saveOpeningBook"> ON</label></div>
      <template v-if="expandedSections.openingBook">
      <label><input v-model="openingBookLocal.showSuggestions" type="checkbox" @change="saveOpeningBook"> 추천 수 표시</label>
      <label>추천 표시 개수 <input v-model.number="openingBookLocal.recommendationCount" min="1" max="8" type="number" @change="saveOpeningBook"></label>
      <label><input v-model="openingBookLocal.autoResponse" type="checkbox" @change="saveOpeningBook"> 자동 응수 사용</label>
      <label>자동 응수 다양성
        <select v-model.number="openingBookLocal.autoResponseTopK" @change="saveOpeningBook">
          <option :value="1">안정(상위 1수)</option>
          <option :value="2">균형(상위 2수)</option>
          <option :value="3">다양(상위 3수)</option>
          <option :value="5">확장(상위 5수)</option>
        </select>
      </label>
      <label>선택 정책
        <select v-model="openingBookLocal.moveSelectionPolicy" @change="saveOpeningBook">
          <option value="practical">실전형</option>
          <option value="deep-priority">깊이 우선</option>
          <option value="user-priority">사용자 우선</option>
        </select>
      </label>
      <label>자동 응수 다양성 <input v-model.number="openingBookLocal.autoResponseTemperature" min="0.4" max="1.6" step="0.1" type="number" @change="saveOpeningBook"></label>
      <label><input v-model="openingBookLocal.autoGenerateEnabled" type="checkbox" @change="saveOpeningBook"> 자동 오프닝 생성 사용</label>
      <label><input v-model="openingBookLocal.useStartPool" type="checkbox" @change="saveOpeningBook"> 시작 포지션 풀 사용</label>
      <label v-if="isJanggiVariant"><input v-model="openingBookLocal.useStandard16OpeningSet" type="checkbox" @change="saveOpeningBook"> 표준 16 시작 포지션 사용</label>
      <label v-if="isJanggiVariant && openingBookLocal.useStandard16OpeningSet">표준 16 선택 방식
        <select v-model="openingBookLocal.standard16SelectionMode" @change="saveOpeningBook">
          <option value="cycle">순환</option>
          <option value="random">랜덤</option>
        </select>
      </label>
      <label>자동 생성 대국 수 <input v-model.number="openingBookLocal.autoGenerateIterations" min="1" type="number" @change="saveOpeningBook"></label>
      <label><input v-model="openingBookLocal.autoGenerateUnlimited" type="checkbox" @change="saveOpeningBook"> 연속 생성(중간 저장)</label>
      <label>자동 진행 최대 수 <input v-model.number="openingBookLocal.autoGenerateMaxPlies" min="2" max="80" type="number" @change="saveOpeningBook"></label>
      <label>생성 분석 깊이 <input v-model.number="openingBookLocal.autoGenerateDepth" min="4" max="30" type="number" @change="saveOpeningBook"></label>
      <label>추천수 반영 최소 횟수 <input v-model.number="openingBookLocal.autoGenerateMinTrustedCount" min="0" max="30" type="number" @change="saveOpeningBook"></label>
      <label>초반 랜덤 진행 수 <input v-model.number="openingBookLocal.autoGenerateEarlyPlies" min="2" max="40" type="number" @change="saveOpeningBook"></label>
      <label>생성 MultiPV 후보 수 <input v-model.number="openingBookLocal.autoGenerateTopK" min="1" max="8" type="number" @change="saveOpeningBook"></label>
      <label>분기 허용 CP 임계값 <input v-model.number="openingBookLocal.autoGenerateCpThreshold" min="0" max="300" type="number" @change="saveOpeningBook"></label>
      <label>최소 유지 깊이 <input v-model.number="cleanupMinDepth" min="1" max="40" type="number"></label>
      <label><input v-model="openingBookLocal.cleanupUseQualityFilter" type="checkbox" @change="saveOpeningBook"> 정리 시 품질 필터 사용</label>
      <label>정리 CP 델타 <input v-model.number="openingBookLocal.cleanupCpDelta" min="20" max="400" type="number" @change="saveOpeningBook"></label>
      <button type="button" @click="cleanupShallowOpeningData">낮은 깊이 데이터 정리</button>
      <label>초반 변화 다양성 <input v-model.number="openingBookLocal.autoGenerateTemperature" min="0.6" max="1.8" step="0.1" type="number" @change="saveOpeningBook"></label>
      <label><input v-model="openingBookLocal.earlyRandomEnabled" type="checkbox" @change="saveOpeningBook"> 초반 랜덤 진행 사용</label>
      <label>시작 포지션 일괄 입력</label>
      <textarea v-model="poolBulkText" rows="4" placeholder="한 줄에 하나씩 입력: 이름|FEN 또는 FEN" />
      <div class="book-actions">
        <button type="button" @click="importStartPositions">시작 포지션 반영</button>
      </div>
      <small>입력한 포지션은 현재 변형({{ variant }})에만 저장됩니다.</small>
      <div v-if="startPool.length" class="start-pool-list">
        <div v-for="(item, idx) in startPool" :key="`${item.name}-${idx}`" class="start-pool-item">
          <span>{{ item.name }}</span>
          <button type="button" @click="removeStartPosition(idx)">삭제</button>
        </div>
      </div>
      <small>오프닝북 데이터는 앱의 로컬 저장소에 자동 보관됩니다. (openingBookGraph / openingBookConfig)</small>
      <input ref="openingBookFile" type="file" accept="application/json,.json,.txt" style="display:none" @change="handleOpeningBookFile">
      <div class="book-actions">
        <button type="button" @click="saveOpeningBookSnapshot">오프닝북 저장</button>
        <button type="button" @click="loadOpeningBookSnapshot">오프닝북 불러오기</button>
        <button type="button" @click="downloadOpeningBook">오프닝북 파일 내보내기</button>
        <button type="button" @click="pickOpeningBookFile('replace')">파일 가져오기(교체)</button>
        <button type="button" @click="pickOpeningBookFile('merge')">파일 가져오기(병합)</button>
      </div>
      <div class="book-actions">
        <button v-if="!openingGeneration.running" type="button" @click="runAutoOpeningGeneration">자동 오프닝 생성 실행</button>
        <button v-if="!openingGeneration.running" type="button" @click="runAutoOpeningGenerationFromCurrentPosition">현재 포지션에서 생성</button>
        <button v-else type="button" @click="stopAutoOpeningGeneration">자동 오프닝 생성 중지</button>
        <button type="button" @click="exportOpeningBook">오프닝북 클립보드 복사</button>
        <button type="button" @click="clearOpeningBook">오프닝북 초기화</button>
      </div>
      <small>진행 상황: {{ openingGeneration.completedGames }}판 / {{ openingGeneration.completedMoves }}수</small>
      <small>현재 시작 포지션: {{ openingGeneration.currentStart || '-' }}</small>
      <small>현재 분석 깊이: {{ openingGeneration.currentDepth || 0 }}</small>
      <small>현재 분석 중인 수: {{ openingGeneration.currentMove || '-' }}</small>
      <small>저장된 분기 수: {{ openingGeneration.savedBranches || 0 }}</small>
      <small>마지막 종료 사유: {{ openingGeneration.lastStopReason || '-' }}</small>
      <small v-if="openingGeneration.lastStopDetail">상세: {{ openingGeneration.lastStopDetail }}</small>
      </template>
    </div>

    <div v-if="deepAnalysis.error" class="deep-error">
      {{ deepAnalysis.error }}
    </div>

    <div v-if="deepAnalysis.report" class="deep-report">
      <div class="report-heading">
        <strong>심층 분석 리포트</strong>
        <button type="button" @click="clearDeepAnalysis">지우기</button>
      </div>
      <small>
        {{ deepAnalysis.report.summary.candidateCount }} 개 후보 ·
        {{ deepAnalysis.report.summary.volatileCount }} 개 불안정 ·
        {{ formatMs(deepAnalysis.report.elapsedMs) }} 소요
      </small>
      <div
        v-for="candidate in deepAnalysis.report.candidates"
        :key="candidate.move"
        :class="['candidate-card', volatilityClass(candidate.stability)]"
      >
        <div class="candidate-title">
          <strong>#{{ candidate.finalRank }} {{ candidate.move }}</strong>
          <span>{{ stabilityText(candidate.stability) }}</span>
        </div>
        <small>{{ diversityText(candidate.diversityTag) }}</small>
        <div class="candidate-grid">
          <span>최종 {{ scoreText(candidate.finalScore) }}</span>
          <span>최고 {{ cpText(candidate.maxScore) }}</span>
          <span>흔들림 {{ cpText(candidate.evalDrift) }}</span>
          <span>깊이 {{ candidate.depthReached || '-' }}</span>
          <span>시간 {{ formatMs(candidate.timeMs) }}</span>
          <span>PV 변화 {{ candidate.pvChanges }}</span>
          <span>최선수 교체 {{ candidate.bestMoveSwitches }}</span>
          <span>순위 변화 {{ rankChange(candidate.rankingChange) }}</span>
        </div>
        <small v-if="candidate.final && candidate.final.pvUCI">PV {{ candidate.final.pvUCI }}</small>
        <div class="flags">
          <span v-if="candidate.flags && candidate.flags.highDisagreement">평가 불일치 큼</span>
          <span v-if="candidate.flags && candidate.flags.lateImprovement">후반 개선</span>
          <span v-if="candidate.flags && candidate.flags.collapsedCandidate">후보 붕괴</span>
          <span v-if="candidate.flags && candidate.flags.dynamicallyExtended">동적 연장</span>
        </div>
      </div>
    </div>
  </div>
</template>
<script>
import { copyTextReliable } from '../../shared/clipboard'

export default {
  name: 'AnalysisVisualizationSettings',
  data: () => ({ local: {}, depthMode: '12', targetDepth: '15', openingBookLocal: {}, poolBulkText: '', cleanupMinDepth: 12, pendingImportMode: 'replace', expandedSections: {} }),
  computed: {
    cfg () { return this.$store.getters.analysisVisualization },
    deepAnalysis () { return this.$store.getters.deepAnalysis },
    openingBook () { return this.$store.getters.openingBook },
    startPool () { return this.$store.getters.openingStartPool || [] },
    variant () { return this.$store.getters.variant },
    isJanggiVariant () { return ['janggi', 'janggimodern'].includes(this.variant) },
    openingGeneration () { return this.$store.state.openingGeneration || { running: false, completedGames: 0, completedMoves: 0 } },
    humanTrapMode: {
      get () { return !!(this.$store.state.startGameModal && this.$store.state.startGameModal.humanTrapMode) },
      set (value) { this.$store.commit('startGameModal', { humanTrapMode: !!value }) }
    },
    closeWinMode: {
      get () { return !!(this.$store.state.startGameModal && this.$store.state.startGameModal.closeWinMode) },
      set (value) { this.$store.commit('startGameModal', { closeWinMode: !!value }) }
    },
    pressureMode: {
      get () { return !!(this.$store.state.startGameModal && this.$store.state.startGameModal.pressureMode) },
      set (value) { this.$store.commit('startGameModal', { pressureMode: !!value }) }
    },
    hunterMode: {
      get () { return !!(this.$store.state.startGameModal && this.$store.state.startGameModal.hunterMode) },
      set (value) { this.$store.commit('startGameModal', { hunterMode: !!value }) }
    },
    closerMode: {
      get () { return !!(this.$store.state.startGameModal && this.$store.state.startGameModal.closerMode) },
      set (value) { this.$store.commit('startGameModal', { closerMode: !!value }) }
    }
  },
  watch: {
    cfg: {
      deep: true,
      immediate: true,
      handler () {
        this.local = { ...this.cfg }
        this.depthMode = this.cfg.trajectoryUnlimited ? 'unlimited' : String(this.cfg.trajectoryDepth)
        this.targetDepth = this.cfg.analysisTargetDepth || '15'
      }
    },
    openingBook: {
      deep: true,
      immediate: true,
      handler () {
        this.openingBookLocal = { ...this.openingBook }
      }
    }
  },
  methods: {
    toggleSection (key) { this.$set(this.expandedSections, key, !this.expandedSections[key]) },
    sectionArrow (key) { return this.expandedSections[key] ? '▼' : '▶' },
    save () {
      this.$store.dispatch('analysisVisualization', this.local)
      if (typeof this.local.multiPvCount === 'number' && this.local.multiPvCount > 0) {
        this.$store.dispatch('setEngineOptions', { MultiPV: this.local.multiPvCount })
      }
    },
    saveDepth () { this.local.trajectoryUnlimited = this.depthMode === 'unlimited'; if (!this.local.trajectoryUnlimited) this.local.trajectoryDepth = Number(this.depthMode); this.save() },
    saveTarget () { this.$store.dispatch('analysisVisualization', { analysisTargetDepth: this.targetDepth }) },
    applyReviewPreset () {
      const presets = {
        fast: { reviewDepth: 8, reviewTacticalDepth: 6, reviewStrategicHorizon: 8, reviewPunishmentLineLength: 4, reviewDetailLevel: 'compact' },
        normal: { reviewDepth: 10, reviewTacticalDepth: 8, reviewStrategicHorizon: 20, reviewPunishmentLineLength: 6, reviewDetailLevel: 'balanced' },
        deep: { reviewDepth: 16, reviewTacticalDepth: 14, reviewStrategicHorizon: 36, reviewPunishmentLineLength: 8, reviewDetailLevel: 'verbose' },
        expert: { reviewDepth: 22, reviewTacticalDepth: 20, reviewStrategicHorizon: 60, reviewPunishmentLineLength: 12, reviewDetailLevel: 'verbose' }
      }
      this.local = { ...this.local, ...(presets[this.local.reviewDepthPreset] || presets.normal) }
      this.save()
    },
    saveMs (key, seconds) {
      const value = Math.max(1, Number(seconds) || 1) * 1000
      this.local[key] = value
      this.save()
    },
    startDeepAnalysis () {
      this.save()
      this.$store.dispatch('startDeepAnalysis')
    },
    clearDeepAnalysis () {
      this.$store.dispatch('clearDeepAnalysis')
    },
    msToSec (value) {
      return Math.round((Number(value) || 0) / 1000)
    },
    formatMs (value) {
      if (!value) return '0s'
      const seconds = Math.round(value / 1000)
      if (seconds < 60) return `${seconds}s`
      return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    },
    cpText (value) {
      if (typeof value !== 'number') return '-'
      return `${value >= 0 ? '+' : ''}${Math.round(value)}cp`
    },
    scoreText (score) {
      if (!score) return '-'
      if (typeof score.mate === 'number') return `M${score.mate}`
      return this.cpText(score.normalized)
    },
    rankChange (value) {
      if (!value) return '0'
      return value > 0 ? `+${value}` : String(value)
    },
    stabilityText (value) {
      if (value === 'highly volatile') return '매우 불안정'
      if (value === 'unstable') return '불안정'
      return '안정적'
    },
    diversityText (value) {
      const labels = {
        'forcing / tactical': '강제 전술 후보',
        'advantage conversion': '우세 전환 후보',
        'defensive resource': '수비 자원 후보',
        'alternative plan': '대안 계획 후보',
        'principal plan': '주요 계획 후보',
        'engine bestmove fallback': '엔진 최선수 보조 후보',
        'engine candidate': '엔진 후보수'
      }
      return labels[value] || value || '후보수'
    },
    volatilityClass (value) {
      if (value === 'highly volatile') return 'volatile-high'
      if (value === 'unstable') return 'volatile-medium'
      return 'volatile-stable'
    },
    saveOpeningBook () {
      this.openingBookLocal.recommendationCount = Math.max(1, Math.min(8, Number(this.openingBookLocal.recommendationCount) || 3))
      this.openingBookLocal.standard16SelectionMode = this.openingBookLocal.standard16SelectionMode === 'random' ? 'random' : 'cycle'
      this.$store.dispatch('openingBook', this.openingBookLocal)
    },
    async saveOpeningBookSnapshot () {
      await this.$store.dispatch('saveOpeningBookSnapshot')
      alert('오프닝북을 로컬 저장 슬롯에 저장했습니다.')
    },
    async loadOpeningBookSnapshot () {
      if (!confirm('저장된 오프닝북을 불러와 현재 데이터를 교체할까요?')) return
      const ok = await this.$store.dispatch('loadOpeningBookSnapshot')
      alert(ok ? '오프닝북을 불러왔습니다.' : '저장된 오프닝북을 찾지 못했습니다.')
    },
    async openingBookSnapshotText () {
      const snapshot = await this.$store.dispatch('createOpeningBookSnapshot')
      return `LIGROUND-OPENING-BOOK/2\n${JSON.stringify(snapshot, null, 2)}`
    },
    async downloadOpeningBook () {
      const text = await this.openingBookSnapshotText()
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const blob = new Blob([text], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `liground-opening-book-${stamp}.json`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    },
    pickOpeningBookFile (mode) {
      this.pendingImportMode = mode === 'merge' ? 'merge' : 'replace'
      if (this.$refs.openingBookFile) {
        this.$refs.openingBookFile.value = ''
        this.$refs.openingBookFile.click()
      }
    },
    handleOpeningBookFile (event) {
      const file = event && event.target && event.target.files && event.target.files[0]
      if (!file) return
      const mode = this.pendingImportMode === 'merge' ? 'merge' : 'replace'
      if (mode === 'replace' && !confirm('파일의 오프닝북으로 현재 데이터를 교체할까요?')) return
      const reader = new FileReader()
      reader.onload = async () => {
        const ok = await this.$store.dispatch('importOpeningBookSnapshot', { text: String(reader.result || ''), mode })
        alert(ok ? (mode === 'merge' ? '오프닝북 파일을 병합했습니다.' : '오프닝북 파일을 가져왔습니다.') : '오프닝북 파일을 읽지 못했습니다.')
      }
      reader.readAsText(file)
    },
    async exportOpeningBook () {
      const text = await this.openingBookSnapshotText()
      const result = await copyTextReliable(text)
      if (result.ok) alert('오프닝북 백업 데이터를 복사했습니다.')
      else alert('백업 복사에 실패했습니다.')
    },
    clearOpeningBook () {
      if (!confirm('오프닝북 데이터를 초기화할까요?')) return
      this.$store.dispatch('clearOpeningBookStorage')
      alert('오프닝북 데이터를 초기화했습니다.')
    },
    async runAutoOpeningGeneration () {
      this.saveOpeningBook()
      const result = await this.$store.dispatch('runAutoOpeningGeneration')
      const games = result && result.generatedGames ? result.generatedGames : 0
      const moves = result && result.generatedMoves ? result.generatedMoves : 0
      alert(`자동 생성 완료: ${games}판, ${moves}수 누적`)
    },
    async runAutoOpeningGenerationFromCurrentPosition () {
      this.saveOpeningBook()
      const result = await this.$store.dispatch('runAutoOpeningGenerationFromCurrentPosition')
      const games = result && result.generatedGames ? result.generatedGames : 0
      const moves = result && result.generatedMoves ? result.generatedMoves : 0
      alert(`현재 포지션 생성 완료: ${games}판, ${moves}수 누적`)
    },
    stopAutoOpeningGeneration () {
      this.$store.dispatch('stopAutoOpeningGeneration')
    },
    async cleanupShallowOpeningData () {
      const minDepth = Math.max(1, Number(this.cleanupMinDepth) || 12)
      if (!confirm(`깊이 ${minDepth} 미만의 오프닝 데이터를 삭제하시겠습니까?`)) return
      const result = await this.$store.dispatch('cleanupOpeningBookByMinDepth', {
        minDepth,
        useQualityFilter: this.openingBookLocal.cleanupUseQualityFilter,
        cpDelta: this.openingBookLocal.cleanupCpDelta
      })
      const removed = result && typeof result.removedTransitions === 'number' ? result.removedTransitions : 0
      const quality = result && typeof result.removedForQuality === 'number' ? result.removedForQuality : 0
      const buckets = result && typeof result.removedBuckets === 'number' ? result.removedBuckets : 0
      alert(`오프닝북 정리 완료: ${removed}개 전이 삭제, ${buckets}개 깊이 버킷 정리 (품질 필터 ${quality}개)`)
    },
    importStartPositions () {
      const raw = String(this.poolBulkText || '').trim()
      if (!raw) return
      const rows = raw.split(/\r?\n/).map(v => v.trim()).filter(Boolean)
      const parsed = rows.map((row, idx) => {
        const bar = row.indexOf('|')
        if (bar > 0) return { name: row.slice(0, bar).trim() || `포지션 ${idx + 1}`, variant: this.variant, fen: row.slice(bar + 1).trim() }
        return { name: `포지션 ${idx + 1}`, variant: this.variant, fen: row }
      }).filter(item => item.fen)
      if (!parsed.length) return
      this.$store.dispatch('openingStartPool', [...this.startPool, ...parsed])
      this.poolBulkText = ''
      alert(`${parsed.length}개의 시작 포지션을 반영했습니다.`)
    },
    removeStartPosition (idx) {
      const next = this.startPool.slice()
      next.splice(idx, 1)
      this.$store.dispatch('openingStartPool', next)
    }
  }
}
</script>
<style scoped>
.viz-settings { margin: 8px 0; padding: 8px; background: var(--second-bg-color); border-radius: 6px; font-size: 12px; color: var(--main-text-color); display:flex; flex-direction:column; gap:6px; }
.section-head { padding: 7px 9px; border-radius: 6px; background: rgba(127,127,127,.16); cursor: pointer; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.inline-toggle { margin-left: auto; font-weight: 400; }
label { display:flex; justify-content:space-between; gap:8px; align-items:center; }
input[type="number"], select { max-width: 130px; background: var(--main-bg-color); color: var(--main-text-color); border: 1px solid var(--main-border-color); border-radius: 3px; }
h4 { margin: 0 0 4px 0; }
button { border: none; border-radius: 4px; padding: 6px 8px; background: #7289da; color: white; cursor: pointer; }
button:disabled { cursor: default; opacity: 0.6; }
small { color: var(--second-text-color, #9aa0a6); overflow-wrap: anywhere; }
.personality-box { display: flex; flex-direction: column; gap: 6px; margin: 4px 0; padding: 8px; border: 1px solid var(--main-border-color); border-radius: 4px; background: rgba(127,127,127,0.08); }
.personality-box h4 { margin: 0 0 2px 0; }
.deep-box { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--main-border-color); }
.radio-row { justify-content: flex-start; }
.deep-error { padding: 6px; border-left: 4px solid #d7263d; background: rgba(215, 38, 61, 0.18); }
.deep-report { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--main-border-color); }
.deep-advanced { display: flex; flex-direction: column; gap: 6px; padding: 6px; border-radius: 4px; background: rgba(127,127,127,0.08); }
.deep-advanced[open] { display: flex; }
.deep-advanced summary { cursor: pointer; font-weight: 700; }
.deep-advanced label { margin-top: 6px; }
.report-heading, .candidate-title { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
.report-heading button { background: #555; }
.candidate-card { padding: 7px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.16); background: rgba(127,127,127,0.10); }
.candidate-title span { padding: 2px 6px; border-radius: 999px; font-size: 10px; background: rgba(127,127,127,0.25); }
.candidate-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 8px; margin: 5px 0; }
.flags { display: flex; flex-wrap: wrap; gap: 4px; }
.flags span { padding: 2px 5px; border-radius: 999px; background: rgba(242,153,74,0.25); color: #ffd08a; }
.volatile-stable { border-left: 4px solid #2f855a; }
.volatile-medium { border-left: 4px solid #f2994a; }
.volatile-high { border-left: 4px solid #d7263d; }
.start-pool-list { display: flex; flex-direction: column; gap: 4px; max-height: 140px; overflow: auto; }
.start-pool-item { display: flex; justify-content: space-between; gap: 8px; align-items: center; background: rgba(127,127,127,0.1); padding: 4px 6px; border-radius: 4px; }
</style>
