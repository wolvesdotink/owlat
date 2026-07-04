<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue';
import { Link, Unlink } from '@lucide/vue';
import UiButton from '@owlat/ui/components/ui/Button.vue';
import UiModal from '@owlat/ui/components/ui/Modal.vue';

const props = defineProps<{
	initialUrl?: string;
	isEditing?: boolean;
}>();

const emit = defineEmits<{
	(e: 'apply', url: string): void;
	(e: 'remove'): void;
	(e: 'close'): void;
}>();

const urlInput = ref('');
const inputEl = ref<HTMLInputElement | null>(null);

onMounted(() => {
	urlInput.value = props.initialUrl || '';
	nextTick(() => {
		inputEl.value?.focus();
		inputEl.value?.select();
	});
});

function handleApply() {
	const url = urlInput.value.trim();
	if (!url) return;
	// Auto-add https:// if missing protocol
	const finalUrl = /^(https?:\/\/|mailto:|tel:)/.test(url) ? url : `https://${url}`;
	emit('apply', finalUrl);
}

function handleKeydown(event: KeyboardEvent) {
	if (event.key === 'Enter') {
		event.preventDefault();
		handleApply();
	}
}
</script>

<template>
	<UiModal :open="true" :title="isEditing ? 'Edit Link' : 'Add Link'" size="sm" @update:open="emit('close')">
		<div @keydown="handleKeydown">
			<label class="block text-xs font-medium text-text-secondary mb-1.5" for="link-url">URL</label>
			<input
				id="link-url"
				ref="inputEl"
				v-model="urlInput"
				class="w-full px-3 py-2 text-sm bg-white/[0.04] border border-border-subtle rounded-lg text-text-primary outline-none transition-[border-color,box-shadow] duration-(--motion-fast) focus:border-brand focus:ring-1 focus:ring-brand"
				type="url"
				placeholder="https://example.com"
				autocomplete="off"
			/>
		</div>

		<template #footer>
			<UiButton
				v-if="isEditing"
				variant="danger-ghost"
				size="sm"
				@click="emit('remove')"
			>
				<template #iconLeft>
					<Unlink class="w-3.5 h-3.5" />
				</template>
				Remove link
			</UiButton>
			<div class="flex-1" />
			<UiButton variant="secondary" size="sm" @click="emit('close')">
				Cancel
			</UiButton>
			<UiButton
				variant="primary"
				size="sm"
				:disabled="!urlInput.trim()"
				@click="handleApply"
			>
				{{ isEditing ? 'Update' : 'Apply' }}
			</UiButton>
		</template>
	</UiModal>
</template>
