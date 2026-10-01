<script setup lang="ts">
import { AlertTriangle } from '@lucide/vue';
import UiButton from '@owlat/ui/components/ui/Button.vue';
import UiModal from '@owlat/ui/components/ui/Modal.vue';

defineProps<{
	show: boolean;
	/**
	 * A Save is in flight. Save shows its progress and Discard waits for it;
	 * Cancel stays available and only dismisses the prompt.
	 */
	saving?: boolean;
}>();

const emit = defineEmits<{
	(e: 'close'): void;
	(e: 'discard'): void;
	(e: 'save'): void;
}>();
</script>

<template>
	<UiModal :open="show" title="Unsaved Changes" @update:open="emit('close')">
		<div class="flex items-center gap-3 mb-4">
			<div class="p-2 rounded-full bg-warning/10">
				<AlertTriangle class="w-5 h-5 text-warning" />
			</div>
			<p class="text-text-secondary">
				You have unsaved changes. Do you want to save them before leaving?
			</p>
		</div>

		<template #footer>
			<UiButton variant="danger-outline" :disabled="saving" @click="emit('discard')">
				Discard
			</UiButton>
			<UiButton variant="secondary" @click="emit('close')"> Cancel </UiButton>
			<UiButton variant="primary" :loading="saving" @click="emit('save')"> Save </UiButton>
		</template>
	</UiModal>
</template>
