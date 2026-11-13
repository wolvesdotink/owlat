<script setup lang="ts">
/**
 * Minimal move-to-folder picker dialog for the keyboard flow ("v"): lists the
 * destination folders and emits the picked one. Dumb by design (props + emit)
 * so the thread list and the reader can both drive it; the caller filters out
 * non-destination folders (sent/drafts/current).
 *
 * With `mailboxes`, an "Other mailboxes" section follows: each row moves the
 * message there, its Copy button copies it. A connected account is marked, and
 * a note says that mail moved into one stays put until the provider has it
 * (`usePostboxMailboxTransfer`).
 */

import type { Id } from '@owlat/api/dataModel';
import type {
	PostboxTransferMode,
	PostboxTransferTarget,
} from '~/composables/postbox/usePostboxMailboxTransfer';
import { postboxFolderLabel } from '~/composables/postbox/usePostboxFolderName';
import { FolderIcon, InboxIcon, LinkIcon, UsersIcon } from '@coolicons/vue';

withDefaults(
	defineProps<{
		open: boolean;
		folders: Array<{ _id: Id<'mailFolders'>; name: string; role?: string }>;
		mailboxes?: PostboxTransferTarget[];
	}>(),
	{ mailboxes: () => [] }
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
					class="w-full flex items-center gap-2 px-3 py-2 rounded hover:bg-bg-surface text-left text-sm"
					@click="emit('pick', folder._id)"
				>
					<FolderIcon class="w-4 h-4 text-text-tertiary flex-shrink-0" />
					{{ postboxFolderLabel(t, folder) }}
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
						class="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 rounded text-left text-sm hover:bg-bg-surface"
						:aria-label="
							t('components.postbox.postboxMovePickerDialog.moveTo', { name: mailbox.name })
						"
						@click="emit('pick-mailbox', mailbox.mailboxId, 'move')"
					>
						<component
							:is="mailbox.isConnected ? LinkIcon : mailbox.isShared ? UsersIcon : InboxIcon"
							class="w-4 h-4 text-text-tertiary flex-shrink-0"
						/>
						<span class="truncate">{{ mailbox.name }}</span>
					</button>
					<button
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
		</template>
	</UiModal>
</template>
