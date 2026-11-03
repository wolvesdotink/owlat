<script setup lang="ts">
/**
 * The strip at the top of Trash and Spam: how much is in there and an "Empty"
 * button. Only someone who may empty the folder sees it, and only while the
 * folder holds something.
 */
import type { Id } from '@owlat/api/dataModel';
import { isEmptyableRole } from '~/composables/postbox/usePostboxFolderBulk';
import { TrashIcon } from '@coolicons/vue';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	folderRole: string;
}>();

const { t } = useI18n();
const mailboxIdRef = computed(() => props.mailboxId);
const { folderBySlug } = usePostboxFolders(mailboxIdRef);
const bulk = usePostboxFolderBulk(mailboxIdRef);

const folder = computed(() => folderBySlug(props.folderRole) ?? null);
const role = computed(() => (isEmptyableRole(props.folderRole) ? props.folderRole : null));
</script>

<template>
	<div
		v-if="folder && role && bulk.canEmpty(folder)"
		class="flex items-center justify-between gap-2 border-b border-border-subtle px-4 py-2 text-xs text-text-secondary"
	>
		<span>{{
			t(
				`components.postbox.postboxFolderActions.count.${role}`,
				{ count: folder.totalCount },
				folder.totalCount
			)
		}}</span>
		<UiButton variant="danger-ghost" size="sm" @click="bulk.requestEmpty(folder)">
			<TrashIcon class="w-3.5 h-3.5" aria-hidden="true" />
			{{ t(`components.postbox.postboxFolderActions.empty.${role}`) }}
		</UiButton>
	</div>
</template>
