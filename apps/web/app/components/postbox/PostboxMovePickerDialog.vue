<script setup lang="ts">
/**
 * Minimal move-to-folder picker dialog for the keyboard flow ("v"): lists the
 * destination folders and emits the picked one. Dumb by design (props + emit)
 * so the thread list and the reader can both drive it; the caller filters out
 * non-destination folders (sent/drafts/current).
 *
 * With `mailboxes`, an "Other mailboxes" section follows: each row moves the
 * message there, its Copy button copies it. A connected account is listed but
 * not pickable, and `canMove: false` (the message sits in a connected account)
 * leaves only Copy; `usePostboxMailboxTransfer` explains why.
 */

import type { Id } from '@owlat/api/dataModel';
import type {
	PostboxTransferMode,
	PostboxTransferTarget,
} from '~/composables/postbox/usePostboxMailboxTransfer';

withDefaults(
	defineProps<{
		open: boolean;
		folders: Array<{ _id: Id<'mailFolders'>; name: string; role?: string }>;
		mailboxes?: PostboxTransferTarget[];
		canMove?: boolean;
	}>(),
	{ mailboxes: () => [], canMove: true }
);

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void;
	(e: 'pick', folderId: Id<'mailFolders'>): void;
	(e: 'pick-mailbox', mailboxId: Id<'mailboxes'>, mode: PostboxTransferMode): void;
}>();

const { t } = useI18n();
</script>

<template>
	<UiModal
		:open="open"
		:title="t('components.postbox.postboxMovePickerDialog.title')"
		size="sm"
		@update:open="emit('update:open', $event)"
	>
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
		<p v-if="folders.length === 0" class="text-sm text-text-tertiary">
			{{ t('components.postbox.postboxMovePickerDialog.noOtherFolders') }}
		</p>
		<template v-if="mailboxes.length > 0">
			<h3 class="mt-4 mb-1 px-3 text-xs font-medium uppercase tracking-wide text-text-tertiary">
				{{ t('components.postbox.postboxMovePickerDialog.otherMailboxes') }}
			</h3>
			<ul class="space-y-1">
				<li v-for="mailbox in mailboxes" :key="mailbox.mailboxId" class="flex items-center gap-1">
					<button
						type="button"
						class="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 rounded text-left text-sm enabled:hover:bg-bg-surface disabled:text-text-tertiary disabled:cursor-not-allowed"
						:disabled="mailbox.isConnected || !canMove"
						:aria-label="
							t('components.postbox.postboxMovePickerDialog.moveTo', { name: mailbox.name })
						"
						@click="emit('pick-mailbox', mailbox.mailboxId, 'move')"
					>
						<Icon
							:name="
								mailbox.isConnected
									? 'lucide:link'
									: mailbox.isShared
										? 'lucide:users'
										: 'lucide:inbox'
							"
							class="w-4 h-4 text-text-tertiary flex-shrink-0"
						/>
						<span class="truncate">{{ mailbox.name }}</span>
					</button>
					<button
						v-if="!mailbox.isConnected"
						type="button"
						class="px-2 py-1 rounded text-xs text-text-secondary hover:bg-bg-surface"
						:aria-label="
							t('components.postbox.postboxMovePickerDialog.copyTo', { name: mailbox.name })
						"
						@click="emit('pick-mailbox', mailbox.mailboxId, 'copy')"
					>
						{{ t('components.postbox.postboxMovePickerDialog.copy') }}
					</button>
				</li>
			</ul>
			<p v-if="mailboxes.some((m) => m.isConnected)" class="mt-2 px-3 text-xs text-text-tertiary">
				{{ t('components.postbox.postboxMovePickerDialog.connectedNote') }}
			</p>
			<p v-if="!canMove" class="mt-2 px-3 text-xs text-text-tertiary">
				{{ t('components.postbox.postboxMovePickerDialog.copyOnlyNote') }}
			</p>
		</template>
	</UiModal>
</template>
