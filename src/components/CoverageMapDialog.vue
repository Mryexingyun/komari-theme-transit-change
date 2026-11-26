<script setup lang="ts">
import NodeCoverageMap from '@/components/NodeCoverageMap.vue'
import { AppDialog } from '@/components/ui/app-dialog'

defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  'update:open': [open: boolean]
  'openRegion': [uuid: string, code: string]
}>()
</script>

<template>
  <AppDialog
    :open="open"
    title="点亮地图"
    description="按国家点亮的节点覆盖图"
    icon="tabler:world"
    content-class="max-w-[min(96vw,84rem)]"
    @update:open="emit('update:open', $event)"
  >
    <div class="h-[min(70vh,44rem)] min-h-72">
      <NodeCoverageMap @open-region="(uuid: string, code: string) => emit('openRegion', uuid, code)" />
    </div>
  </AppDialog>
</template>
