<template>
  <div class="viz-settings">
    <h4>Visualization</h4>
    <label><input v-model="local.showMultiPvArrows" type="checkbox" @change="save"> MultiPV arrows</label>
    <label>Top N <input v-model.number="local.multiPvCount" min="1" type="number" @change="save"></label>
    <label><input v-model="local.trajectoryEnabled" type="checkbox" @change="save"> Best-line trajectory</label>
    <label>Side
      <select v-model="local.trajectorySideMode" @change="save"><option value="both">Both</option><option value="my">My side</option></select>
    </label>
    <label>Depth
      <select v-model="depthMode" @change="saveDepth"><option value="4">4</option><option value="8">8</option><option value="12">12</option><option value="20">20</option><option value="40">40</option><option value="unlimited">Unlimited</option></select>
    </label>
    <label><input v-model="local.orderNumbers" type="checkbox" @change="save"> Number badges</label>
    <label><input v-model="local.orderThickness" type="checkbox" @change="save"> Thickness</label>
    <label><input v-model="local.orderOpacity" type="checkbox" @change="save"> Opacity</label>
    <label>Target analysis depth
      <select v-model="targetDepth" @change="saveTarget"><option value="infinite">Infinite</option><option value="10">10</option><option value="15">15</option><option value="20">20</option><option value="25">25</option></select>
    </label>
  </div>
</template>
<script>
export default {
  name: 'AnalysisVisualizationSettings',
  data: () => ({ local: {}, depthMode: '12', targetDepth: 'infinite' }),
  computed: { cfg () { return this.$store.getters.analysisVisualization } },
  watch: { cfg: { deep: true, immediate: true, handler () { this.local = { ...this.cfg }; this.depthMode = this.cfg.trajectoryUnlimited ? 'unlimited' : String(this.cfg.trajectoryDepth); this.targetDepth = this.cfg.analysisTargetDepth || 'infinite' } } },
  methods: {
    save () { this.$store.dispatch('analysisVisualization', this.local) },
    saveDepth () { this.local.trajectoryUnlimited = this.depthMode === 'unlimited'; if (!this.local.trajectoryUnlimited) this.local.trajectoryDepth = Number(this.depthMode); this.save() },
    saveTarget () { this.$store.dispatch('analysisVisualization', { analysisTargetDepth: this.targetDepth }) }
  }
}
</script>
<style scoped>
.viz-settings { margin: 8px 0; padding: 8px; background: var(--second-bg-color); border-radius: 6px; font-size: 12px; color: var(--main-text-color); display:flex; flex-direction:column; gap:6px; }
label { display:flex; justify-content:space-between; gap:8px; align-items:center; }
h4 { margin: 0 0 4px 0; }
</style>
