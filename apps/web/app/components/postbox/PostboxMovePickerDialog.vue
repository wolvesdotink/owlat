<script setup lang="ts">
/**
 * Minimal move-to-folder picker dialog for the keyboard flow ("v"): lists the
 * destination folders and emits the picked one. Dumb by design (props + emit)
 * so the thread list and the reader can both drive it; the caller filters out
 * non-destination folders (sent/drafts/current).
 */

import type { Id } from '@owlat/api/dataModel';

defineProps<{
	open: boolean;
	folders: Array<{ _id: Id<'mailFolders'>; name: string; role?: string }>;
}>();

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void;
	(e: 'pick', folderId: Id<'mailFolders'>): void;
}>();
</script>

<template>
	<UiModal :open="open" title="Move to folder" size="sm" @update:open="emit('update:open', $event)">
		<ul class="space-y-1">
			<li v-for="folder in folders" :key="folder._id">
				<button
					type="button"
					class="w-full flex items-center gap-2 px-3 py-2 rounded hover:bg-bg-surface text-left text-sm capitalize"
					@click="emit('pick', folder._id)"
				>
					<Icon name="lucide:folder" class="w-4 h-4 text-text-tertiary flex-shrink-0" />
					{{ folder.role ?? folder.name }}
				</button>
			</li>
		</ul>
		<p v-if="folders.length === 0" class="text-sm text-text-tertiary">No other folders</p>
	</UiModal>
</template>
