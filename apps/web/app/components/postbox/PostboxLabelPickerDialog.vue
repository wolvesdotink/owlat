<script setup lang="ts">
/**
 * Minimal label picker dialog for the keyboard flow ("l"): lists the
 * mailbox's labels and emits the picked one. Dumb by design (props + emit)
 * so the thread list and the reader can both drive it.
 */

import type { Id } from '@owlat/api/dataModel';

defineProps<{
	open: boolean;
	labels: Array<{ _id: Id<'mailLabels'>; name: string; color?: string }>;
}>();

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void;
	(e: 'pick', labelId: Id<'mailLabels'>): void;
}>();
</script>

<template>
	<UiModal :open="open" title="Add label" size="sm" @update:open="emit('update:open', $event)">
		<ul class="space-y-1">
			<li v-for="label in labels" :key="label._id">
				<button
					type="button"
					class="w-full flex items-center gap-2 px-3 py-2 rounded hover:bg-bg-surface text-left text-sm"
					@click="emit('pick', label._id)"
				>
					<span
						class="w-2.5 h-2.5 rounded-full flex-shrink-0"
						:style="{ backgroundColor: label.color || '#6b7280' }"
					/>
					{{ label.name }}
				</button>
			</li>
		</ul>
		<p v-if="labels.length === 0" class="text-sm text-text-tertiary">No labels yet</p>
	</UiModal>
</template>
