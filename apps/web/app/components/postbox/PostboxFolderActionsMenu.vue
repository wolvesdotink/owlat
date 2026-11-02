<script setup lang="ts">
/**
 * The list header's "⋯" folder menu: whole-folder verbs for the folder on
 * screen. Renders nothing for a view that is not one folder (Snoozed, a label,
 * search) or offers no verb, so the header never shows an empty menu.
 */
import type { Id } from '@owlat/api/dataModel';
import {
	canMarkFolderRead,
	findViewFolder,
	isEmptyableRole,
} from '~/composables/postbox/usePostboxFolderBulk';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	folderRole: string;
	folderId?: Id<'mailFolders'>;
}>();

const { t } = useI18n();
const mailboxIdRef = computed(() => props.mailboxId);
const { folders } = usePostboxFolders(mailboxIdRef);
const bulk = usePostboxFolderBulk(mailboxIdRef);

const folder = computed(() => findViewFolder(folders.value, props.folderRole, props.folderId));
const offersMarkRead = computed(() => !!folder.value && folder.value.role !== 'drafts');
const canMarkRead = computed(() => canMarkFolderRead(folder.value));
const canEmpty = computed(() => bulk.canEmpty(folder.value));

const ITEM_CLASS =
	'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left whitespace-nowrap hover:bg-bg-surface disabled:opacity-50 disabled:hover:bg-transparent';
</script>

<template>
	<PostboxOverflowMenu
		v-if="folder && (offersMarkRead || canEmpty)"
		:label="t('components.postbox.postboxFolderActions.menuLabel')"
		trigger-class="px-1.5 py-1 text-text-secondary"
	>
		<template #default="{ close }">
			<button
				v-if="offersMarkRead"
				type="button"
				role="menuitem"
				:class="[ITEM_CLASS, 'text-text-primary']"
				:disabled="!canMarkRead"
				@click="
					void bulk.markAllRead(folder);
					close();
				"
			>
				<Icon name="lucide:check-check" class="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
				{{ t('components.postbox.postboxFolderActions.markAllRead') }}
			</button>
			<button
				v-if="canEmpty && isEmptyableRole(folder.role)"
				type="button"
				role="menuitem"
				:class="[ITEM_CLASS, 'text-error']"
				@click="
					bulk.requestEmpty(folder);
					close();
				"
			>
				<Icon name="lucide:trash-2" class="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
				{{ t(`components.postbox.postboxFolderActions.empty.${folder.role}`) }}
			</button>
		</template>
	</PostboxOverflowMenu>
</template>
