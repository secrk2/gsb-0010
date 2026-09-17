<template>
  <Modal :title="`逾期办结确认 · ${deadline.dtype}`" @close="$emit('cancel')">
    <div class="overdue-box">
      <p class="bad-text" style="margin-top:0">
        ⚠️ 该期限已于 <strong>{{ fmtDate(deadline.due_date) }}</strong> 到期
        <span v-if="details?.today">（所内今日 {{ details.today }}）</span>，
        已逾期 <strong>{{ overdueDays }}</strong> 天。
      </p>
      <p class="small muted">逾期办结须二次确认并如实填写逾期原因，原因将永久留痕（办理人、时间、原因）。</p>
      <div class="field">
        <label>逾期原因 *（至少 2 个字）</label>
        <textarea v-model="reason" rows="3" placeholder="例如：客户用印流程延误 / 等待海外律所确认 / 邮寄异常…"></textarea>
      </div>
      <p v-if="err" class="small bad-text">{{ err }}</p>
      <div class="modal-actions">
        <button class="btn" @click="$emit('cancel')">取消</button>
        <button class="btn danger" :disabled="saving || reason.trim().length < 2" @click="confirm">确认逾期办结并留痕</button>
      </div>
    </div>
  </Modal>
</template>

<script setup>
import { ref, computed } from 'vue'
import Modal from './Modal.vue'
import { fmtDate } from '../utils.js'

const props = defineProps({
  deadline: { type: Object, required: true },
  details: { type: Object, default: () => ({}) },
  saving: Boolean,
  err: String,
})
const emit = defineEmits(['cancel', 'confirm'])
const reason = ref('')
const overdueDays = computed(() => {
  const t = props.details?.today || props.details?.local_today || new Date().toISOString().slice(0, 10)
  return Math.round((Date.parse(t + 'T00:00:00Z') - Date.parse(props.deadline.due_date + 'T00:00:00Z')) / 86400000)
})
function confirm() {
  emit('confirm', reason.value.trim())
}
</script>
