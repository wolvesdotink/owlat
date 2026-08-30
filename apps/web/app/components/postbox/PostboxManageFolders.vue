<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

/**
 * The folders half of "Manage folders & labels".
 *
 * Everything the rail used to hover-reveal on a folder row — create, rename,
 * delete — with room for real labels and a real empty state instead of two 12px
 * glyphs that appeared on mouseover. System folders are not listed: the backend
 * rejects renaming or deleting them, so offering the verbs would be a lie.
 *
 * Delete is NOT confirmed here. It arms the one confirmation dialog the rail
 * owns (`usePostboxManageDialog`), because that dialog is also what a
 * right-click on a rail row reaches, and because the rail is the component that
 * knows to navigate away when you delete the folder you are currently reading.
 */
const props = defineProps<{ mailboxId: Id<'mailboxes'> }>();

const { t } = useI18n();

const mailboxIdRef = computed(() => props.mailboxId);
const { customFolders } = usePostboxFolders(mailboxIdRef);
const folderActions = usePostboxFolderActions(mailboxIdRef);
const { editFolderId, focusCreate, requestFolderDelete } = usePostboxManageDialog();

const newName = ref('');
const newInput = ref<HTMLInputElement | null>(null);
const renamingId = ref<Id<'mailFolders'> | null>(null);
const renameName = ref('');

async function handleCreate() {
	if (await folderActions.create(newName.value)) newName.value = '';
}

function startRename(folder: { _id: Id<'mailFolders'>; name: string }) {
	renamingId.value = folder._id;
	renameName.value = folder.name;
}

async function commitRename() {
	const id = renamingId.value;
	if (!id) return;
	if (await folderActions.rename(id, renameName.value)) renamingId.value = null;
}

// A context menu can ask for a specific row in edit mode; consume the request so
// re-opening the dialog later does not silently re-arm the same rename.
watch(
	editFolderId,
	(id) => {
		if (!id) return;
		const folder = customFolders.value.find((f) => f._id === id);
		if (folder) startRename({ _id: folder._id as Id<'mailFolders'>, name: folder.name });
		editFolderId.value = null;
	},
	{ immediate: true }
);

watch(
	focusCreate,
	async (target) => {
		if (target !== 'folders') return;
		focusCreate.value = null;
		await nextTick();
		newInput.value?.focus();
	},
	{ immediate: true }
);
</script>

<template>
	<section>
		<h3 class="text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2">
			{{ t('components.postbox.postboxManageFolders.heading') }}
		</h3>

		<form class="flex items-center gap-2 mb-3" @submit.prevent="handleCreate">
			<input
				ref="newInput"
				v-model="newName"
				type="text"
				class="input flex-1"
				:placeholder="t('components.postbox.postboxManageFolders.newNamePlaceholder')"
				:aria-label="t('components.postbox.postboxManageFolders.newNamePlaceholder')"
			/>
			<UiButton type="submit" :disabled="!newName.trim()">{{ t('common.add') }}</UiButton>
		</form>

		<ul v-if="customFolders.length > 0" class="space-y-2 max-h-56 overflow-auto">
			<li
				v-for="folder in customFolders"
				:key="folder._id"
				class="flex items-center gap-2 px-3 py-2 rounded border border-border-subtle"
			>
				<Icon name="lucide:folder" class="w-4 h-4 flex-shrink-0 text-text-tertiary" />
				<input
					v-if="renamingId === folder._id"
					v-model="renameName"
					type="text"
					class="input input-sm flex-1"
					:aria-label="t('components.postbox.postboxManageFolders.nameAriaLabel')"
					@blur="commitRename"
					@keyup.enter="commitRename"
					@keyup.escape="renamingId = null"
				/>
				<span v-else class="flex-1 truncate">{{ folder.name }}</span>
				<span v-if="renamingId !== folder._id" class="text-xs text-text-tertiary">
					{{ folder.totalCount }}
				</span>
				<button
					v-if="renamingId !== folder._id"
					type="button"
					class="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface"
					:title="t('components.postbox.postboxManageFolders.rename')"
					:aria-label="
						t('components.postbox.postboxManageFolders.renameAriaLabel', { name: folder.name })
					"
					@click="startRename({ _id: folder._id as Id<'mailFolders'>, name: folder.name })"
				>
					<Icon name="lucide:pencil" class="w-4 h-4" />
				</button>
				<button
					type="button"
					class="p-1 rounded hover:bg-error/10 text-error"
					:title="t('components.postbox.postboxManageFolders.delete')"
					:aria-label="
						t('components.postbox.postboxManageFolders.deleteAriaLabel', { name: folder.name })
					"
					@click="
						requestFolderDelete({ _id: folder._id as Id<'mailFolders'>, name: folder.name })
					"
				>
					<Icon name="lucide:trash-2" class="w-4 h-4" />
				</button>
			</li>
		</ul>
		<p v-else class="text-sm text-text-secondary py-4 text-center">
			{{ t('components.postbox.postboxManageFolders.empty') }}
		</p>
	</section>
</template>
