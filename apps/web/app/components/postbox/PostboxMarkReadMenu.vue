<script setup lang="ts">
/**
 * The "⋯" menu with "Mark all as read" for a list that is not one folder: a
 * label's view, All inboxes and the unified folders. "Empty now" is not here:
 * it stays on one Trash or Spam folder (PostboxFolderActionsMenu), because it
 * deletes for good and must never reach past the folder it names.
 */
import type { Id } from '@owlat/api/dataModel';
import type { PostboxMarkReadTarget } from '~/composables/postbox/usePostboxFolderBulk';
import { CheckAllIcon } from '@coolicons/vue';

const props = defineProps<{
	target: PostboxMarkReadTarget;
	/** False when nothing the target covers is unread (the item stays, disabled). */
	enabled: boolean;
	/** The menu's accessible name. */
	label: string;
	/** The mailbox on screen, if the list has one. */
	mailboxId?: Id<'mailboxes'> | null;
}>();

const { t } = useI18n();
const bulk = usePostboxFolderBulk(computed(() => props.mailboxId ?? null));
</script>

<template>
	<PostboxOverflowMenu :label="label" trigger-class="px-1.5 py-1 text-text-secondary">
		<template #default="{ close }">
			<button
				type="button"
				role="menuitem"
				class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left whitespace-nowrap text-text-primary hover:bg-bg-surface disabled:opacity-50 disabled:hover:bg-transparent"
				:disabled="!enabled"
				@click="
					void bulk.markRead(target);
					close();
				"
			>
				<CheckAllIcon class="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
				{{ t('components.postbox.postboxFolderActions.markAllRead') }}
			</button>
		</template>
	</PostboxOverflowMenu>
</template>
