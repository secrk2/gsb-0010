<template>
  <div class="completion">
    <div class="comp-bar" :title="`${COMPLETION_HINT.documents} 实际：${c.documents.done} 件已归档`">
      <span class="comp-name">官文口径</span>
      <span class="bar"><span class="fill doc" :style="{ width: c.documents.percent + '%' }"></span></span>
      <strong>{{ c.documents.percent }}%</strong>
      <span class="small muted">{{ c.documents.done }}/{{ c.documents.total }}<span v-if="c.documents.capped"> 封顶</span></span>
    </div>
    <div class="comp-bar" :title="COMPLETION_HINT.stages">
      <span class="comp-name">阶段口径</span>
      <span class="bar"><span class="fill stage" :style="{ width: c.stages.percent + '%' }"></span></span>
      <strong>{{ c.stages.percent }}%</strong>
      <span class="small muted">{{ c.stages.done }}/{{ c.stages.total }}</span>
    </div>
    <p v-if="diverged" class="small warn-text">两口径相反：官文已 {{ c.documents.done }} 件但关键阶段仅 {{ c.stages.done }} 个，多为半截官文。</p>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { COMPLETION_HINT } from '../utils.js'

const props = defineProps({ c: { type: Object, required: true } })
const diverged = computed(() => props.c.documents.percent >= 100 && props.c.stages.percent <= 60)
</script>
