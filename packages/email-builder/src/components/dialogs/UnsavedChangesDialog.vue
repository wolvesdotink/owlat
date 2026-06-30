<script setup lang="ts">
import { AlertTriangle } from '@lucide/vue';
import UiButton from '@owlat/ui/components/ui/Button.vue';
import UiModal from '@owlat/ui/components/ui/Modal.vue';

defineProps<{
	show: boolean;
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
			<UiButton variant="danger-outline" @click="emit('discard')">
				Discard
			</UiButton>
			<UiButton variant="secondary" @click="emit('close')">
				Cancel
			</UiButton>
			<UiButton variant="primary" @click="emit('save')">
				Save
			</UiButton>
		</template>
	</UiModal>
</template>
