<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { resolveActiveShortcut } from '~/utils/shortcutScope';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	folderRole: string;
	folderId?: Id<'mailFolders'>;
	/** Ignore the persisted icon-strip collapse and render fully expanded —
	 * used by the stack-mode drawer, which must always open readable. */
	forceExpanded?: boolean;
}>();

const { t } = useI18n();

const mailboxIdRef = computed(() => props.mailboxId);
const { systemFolders, customFolders, unreadByRole } = usePostboxFolders(mailboxIdRef);
const { create: createLabel } = usePostboxLabels(mailboxIdRef);

// Label creation accepts a PATH (`Work/Clients/Acme`) — the backend creates any
// missing ancestor — so nesting is one action rather than three.
const creatingLabel = ref(false);
const newLabelName = ref('');

async function confirmCreateLabel() {
	const name = newLabelName.value.trim();
	if (!name) return;
	if (await createLabel(name)) {
		newLabelName.value = '';
		creatingLabel.value = false;
	}
}

// Collapsible folder rail — icon strip when collapsed. Persisted per-device.
// forceExpanded (drawer staging) wins over the saved preference.
const { collapsed: savedCollapsed, toggle: toggleRail } = usePostboxRailCollapsed();
const railCollapsed = computed(() => !props.forceExpanded && savedCollapsed.value);

// Reply Queue rail badge (the count subscription is shared/deduped with the
// inbox strip in PostboxLayout).
const { count: replyQueueCount } = usePostboxReplyQueue(mailboxIdRef);

// Custom-folder management (create / rename / delete) in the folder rail.
const folderActions = usePostboxFolderActions(mailboxIdRef);
const creatingFolder = ref(false);
const newFolderName = ref('');
const renamingFolderId = ref<Id<'mailFolders'> | null>(null);
const renameFolderName = ref('');
const deletingFolder = ref<{ _id: Id<'mailFolders'>; name: string } | null>(null);
const labelManagerOpen = ref(false);

async function confirmCreateFolder() {
	if (await folderActions.create(newFolderName.value)) {
		newFolderName.value = '';
		creatingFolder.value = false;
	}
}
function startRenameFolder(folder: { _id: Id<'mailFolders'>; name: string }) {
	renamingFolderId.value = folder._id;
	renameFolderName.value = folder.name;
}
async function confirmRenameFolder() {
	if (
		renamingFolderId.value &&
		(await folderActions.rename(renamingFolderId.value, renameFolderName.value))
	) {
		renamingFolderId.value = null;
	}
}
async function confirmDeleteFolder() {
	const folder = deletingFolder.value;
	if (folder && (await folderActions.remove(folder._id)) && props.folderId === folder._id) {
		void navigateTo('/dashboard/postbox/inbox');
	}
	deletingFolder.value = null;
}

// Pinned saved searches — recurring questions ("unread from Ines", "invoices
// with attachments") as rail rows. Each is a plain `?q=` link, so a pinned
// search and a bookmarked one are the same navigation.
const { pinnedSearches, setPinned } = usePostboxSavedSearches(mailboxIdRef);
const route = useRoute();
const activeSavedQuery = computed(() =>
	route.path === '/dashboard/postbox/search' ? String(route.query['q'] ?? '') : ''
);

// The open label view, so the tree can reveal (and mark) its branch.
const activeLabelId = computed(() =>
	route.path.startsWith('/dashboard/postbox/label/') ? String(route.params['labelId'] ?? '') : ''
);

// Search entry point: the app-wide overlay, opened in Mail scope. The rail used
// to host its own box with its own grammar and its own history; there is now one
// search, and `/` reaches it here exactly as it reached the box before.
const { open: openCommandPalette } = useCommandPalette();

function onGlobalKey(event: KeyboardEvent) {
	// Cmd/Ctrl+Shift+D toggles the folder rail between full width and the icon
	// strip. Works regardless of focus so it's reachable from anywhere.
	if (
		(event.metaKey || event.ctrlKey) &&
		event.shiftKey &&
		!event.altKey &&
		event.key.toLowerCase() === 'd'
	) {
		event.preventDefault();
		toggleRail();
		return;
	}
	// `postbox.search` through the registry, not a literal '/': the settings
	// card offers this key for remapping, so the handler has to honour it.
	if (resolveActiveShortcut(event, ['postbox']) !== 'postbox.search') return;
	const el = event.target as HTMLElement | null;
	if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
		return;
	}
	event.preventDefault();
	openCommandPalette({ scope: 'mail' });
}

onMounted(() => {
	window.addEventListener('keydown', onGlobalKey);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey));
</script>

<template>
	<!-- Pane 1: folder rail — collapses to a ~48px icon strip (Cmd/Ctrl+Shift+D
	     or the chevron at the bottom). Collapsed hides folder CRUD and label
	     management; folder/action glyphs stay reachable. Search is not here: it
	     is the app-wide overlay, on `/` and Cmd/Ctrl+K. -->
	<aside
		class="border-r border-border-subtle bg-bg-elevated flex flex-col"
		:class="railCollapsed ? 'w-12 p-2 gap-1.5 items-center' : 'w-56 p-3 gap-2'"
	>
		<!-- Mailbox switcher: personal mailbox(es) + shared (team) inboxes with
		     unread badges. Renders nothing for a lone personal mailbox, so a
		     single-mailbox user's rail is unchanged. -->
		<PostboxMailboxSwitcher :mailbox-id="mailboxId" :collapsed="railCollapsed" />

		<PostboxComposeButton :mailbox-id="mailboxId" :collapsed="railCollapsed" />
		<PostboxFolderList
			:folders="systemFolders"
			:unread-counts="unreadByRole"
			:active-folder="folderRole"
			:collapsed="railCollapsed"
		/>

		<!-- The virtual views (Reply Queue, Snoozed, Files, Subscriptions). None of
		     them has a backing folder — nothing moves when you open one — so they
		     travel together, in their own component. -->
		<PostboxFolderRailVirtualViews
			:collapsed="railCollapsed"
			:folder-role="folderRole"
			:reply-queue-count="replyQueueCount"
		/>

		<!-- Secondary destination: lighter weight than the mail folders so the
		     inbox/folders read as the primary rail. -->
		<NuxtLink
			to="/dashboard/postbox/contacts"
			class="rounded text-sm text-text-tertiary hover:text-text-secondary hover:bg-bg-surface"
			:class="
				railCollapsed
					? 'flex items-center justify-center w-9 h-9'
					: 'flex items-center gap-2 px-2.5 py-1'
			"
			:title="railCollapsed ? t('components.postbox.postboxFolderRail.contacts') : undefined"
			:aria-label="railCollapsed ? t('components.postbox.postboxFolderRail.contacts') : undefined"
		>
			<Icon name="lucide:users" :class="railCollapsed ? 'w-4 h-4' : 'w-3.5 h-3.5'" />
			<span v-if="!railCollapsed" class="flex-1">{{
				t('components.postbox.postboxFolderRail.contacts')
			}}</span>
		</NuxtLink>

		<!-- Postbox settings (accounts, signatures, filters, notifications). The
		     dashboard sidebar links to the Postbox as a whole, so this rail is the
		     one steady entry point to its settings. -->
		<NuxtLink
			to="/dashboard/preferences"
			class="rounded text-sm text-text-tertiary hover:text-text-secondary hover:bg-bg-surface"
			:class="
				railCollapsed
					? 'flex items-center justify-center w-9 h-9'
					: 'flex items-center gap-2 px-2.5 py-1'
			"
			:title="railCollapsed ? t('common.settings') : undefined"
			:aria-label="railCollapsed ? t('common.settings') : undefined"
		>
			<Icon name="lucide:settings" :class="railCollapsed ? 'w-4 h-4' : 'w-3.5 h-3.5'" />
			<span v-if="!railCollapsed" class="flex-1">{{ t('common.settings') }}</span>
		</NuxtLink>

		<!-- Custom folders (no role; user-created or custom IMAP folders).
		     Expanded-only: folder CRUD and label management live here. -->
		<div v-if="!railCollapsed" class="mt-3">
			<header class="flex items-center justify-between mb-1 px-2">
				<span class="text-xs font-semibold uppercase tracking-wider text-text-tertiary">{{
					t('components.postbox.postboxFolderRail.foldersHeading')
				}}</span>
				<button
					type="button"
					class="text-text-tertiary hover:text-text-primary"
					:title="t('components.postbox.postboxFolderRail.newFolder')"
					@click="
						creatingFolder = true;
						newFolderName = '';
					"
				>
					<Icon name="lucide:folder-plus" class="w-3.5 h-3.5" />
				</button>
			</header>
			<div v-if="creatingFolder" class="px-2 py-1">
				<input
					v-model="newFolderName"
					:placeholder="t('components.postbox.postboxFolderRail.folderNamePlaceholder')"
					class="input input-sm"
					:aria-label="t('components.postbox.postboxFolderRail.newFolderNameAriaLabel')"
					@keyup.enter="confirmCreateFolder"
					@keyup.esc="creatingFolder = false"
				/>
			</div>
			<ul class="flex flex-col gap-0.5">
				<li v-for="folder in customFolders" :key="folder._id" class="group flex items-center">
					<input
						v-if="renamingFolderId === folder._id"
						v-model="renameFolderName"
						class="input input-sm flex-1 mx-2"
						:aria-label="t('components.postbox.postboxFolderRail.folderNameAriaLabel')"
						@keyup.enter="confirmRenameFolder"
						@keyup.esc="renamingFolderId = null"
					/>
					<template v-else>
						<NuxtLink
							:to="`/dashboard/postbox/${folder._id}`"
							class="flex-1 flex items-center gap-2 px-2.5 py-1 rounded text-sm hover:bg-bg-surface min-w-0"
							:class="{ 'bg-bg-surface text-brand': folderId === folder._id }"
						>
							<Icon name="lucide:folder" class="w-4 h-4 flex-shrink-0" />
							<span class="truncate">{{ folder.name }}</span>
						</NuxtLink>
						<button
							type="button"
							class="opacity-0 group-hover:opacity-100 p-1 text-text-tertiary hover:text-text-primary"
							:title="t('components.postbox.postboxFolderRail.renameFolder')"
							@click="startRenameFolder(folder)"
						>
							<Icon name="lucide:pencil" class="w-3 h-3" />
						</button>
						<button
							type="button"
							class="opacity-0 group-hover:opacity-100 p-1 text-text-tertiary hover:text-error"
							:title="t('components.postbox.postboxFolderRail.deleteFolder')"
							@click="deletingFolder = { _id: folder._id, name: folder.name }"
						>
							<Icon name="lucide:trash-2" class="w-3 h-3" />
						</button>
					</template>
				</li>
				<li
					v-if="customFolders.length === 0 && !creatingFolder"
					class="text-xs text-text-tertiary px-2 py-1"
				>
					{{ t('components.postbox.postboxFolderRail.noCustomFolders') }}
				</li>
			</ul>
		</div>

		<!-- Pinned saved searches. Expanded-only, and rendered only once something
		     is pinned: an empty section would be a permanent unexplained heading
		     in a rail that is already dense. -->
		<div v-if="!railCollapsed && pinnedSearches.length > 0" class="mt-3">
			<header class="flex items-center justify-between mb-1 px-2">
				<span class="text-xs font-semibold uppercase tracking-wider text-text-tertiary">{{
					t('components.postbox.postboxFolderRail.pinnedSearchesHeading')
				}}</span>
			</header>
			<ul class="flex flex-col gap-0.5">
				<li v-for="saved in pinnedSearches" :key="saved._id" class="group flex items-center">
					<NuxtLink
						:to="savedSearchPath(saved.rawQuery)"
						class="flex-1 flex items-center gap-2 px-2.5 py-1 rounded text-sm hover:bg-bg-surface min-w-0"
						:class="{ 'bg-bg-surface text-brand': activeSavedQuery === saved.rawQuery }"
						:title="saved.rawQuery"
					>
						<Icon name="lucide:search" class="w-4 h-4 flex-shrink-0" />
						<span class="truncate">{{ saved.name }}</span>
					</NuxtLink>
					<button
						type="button"
						class="opacity-0 group-hover:opacity-100 p-1 text-text-tertiary hover:text-text-primary"
						:title="t('components.postbox.postboxFolderRail.unpinSearch')"
						:aria-label="
							t('components.postbox.postboxFolderRail.unpinSearchAriaLabel', { name: saved.name })
						"
						@click="setPinned(saved._id, false)"
					>
						<Icon name="lucide:pin-off" class="w-3 h-3" />
					</button>
				</li>
			</ul>
		</div>

		<!-- Shown expanded so the "Manage labels" affordance (the only way to
		     create the first label) stays reachable; the empty case is handled
		     by the "No labels yet" row below. Collapsed hides labels with the
		     rest of the management UI. -->
		<div v-if="!railCollapsed" class="mt-3">
			<header class="flex items-center justify-between mb-1 px-2">
				<span class="text-xs font-semibold uppercase tracking-wider text-text-tertiary">{{
					t('components.postbox.postboxFolderRail.labelsHeading')
				}}</span>
				<span class="flex items-center gap-1.5">
					<button
						type="button"
						class="text-text-tertiary hover:text-text-primary"
						:title="t('components.postbox.postboxFolderRail.newLabel')"
						@click="
							creatingLabel = true;
							newLabelName = '';
						"
					>
						<Icon name="lucide:plus" class="w-3.5 h-3.5" />
					</button>
					<button
						type="button"
						class="text-text-tertiary hover:text-text-primary"
						:title="t('components.postbox.postboxFolderRail.manageLabels')"
						@click="labelManagerOpen = true"
					>
						<Icon name="lucide:settings-2" class="w-3.5 h-3.5" />
					</button>
				</span>
			</header>
			<div v-if="creatingLabel" class="px-2 py-1">
				<input
					v-model="newLabelName"
					:placeholder="t('components.postbox.postboxFolderRail.labelNamePlaceholder')"
					class="input input-sm"
					:aria-label="t('components.postbox.postboxFolderRail.newLabelNameAriaLabel')"
					@keyup.enter="confirmCreateLabel"
					@keyup.esc="creatingLabel = false"
				/>
				<p class="text-2xs text-text-tertiary mt-1">
					{{ t('components.postbox.postboxFolderRail.labelNestingHint') }}
				</p>
			</div>
			<PostboxLabelTree :mailbox-id="mailboxId" :active-label-id="activeLabelId" />
		</div>

		<!-- Collapse toggle pinned to the rail bottom (also Cmd/Ctrl+Shift+D). -->
		<button
			type="button"
			class="mt-auto flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface"
			:class="railCollapsed ? 'w-9 h-9' : 'w-full gap-1.5 px-2.5 py-1.5 text-xs'"
			:title="
				railCollapsed
					? t('components.postbox.postboxFolderRail.expandSidebarTitle')
					: t('components.postbox.postboxFolderRail.collapseSidebarTitle')
			"
			:aria-label="
				railCollapsed
					? t('components.postbox.postboxFolderRail.expandSidebar')
					: t('components.postbox.postboxFolderRail.collapseSidebar')
			"
			:aria-pressed="railCollapsed"
			@click="toggleRail"
		>
			<Icon
				:name="railCollapsed ? 'lucide:chevrons-right' : 'lucide:chevrons-left'"
				class="w-4 h-4"
			/>
			<span v-if="!railCollapsed">{{ t('components.postbox.postboxFolderRail.collapse') }}</span>
		</button>
	</aside>

	<UiConfirmationDialog
		:open="!!deletingFolder"
		variant="danger"
		:title="t('components.postbox.postboxFolderRail.deleteFolder')"
		:description="
			t('components.postbox.postboxFolderRail.deleteFolderDescription', {
				name: deletingFolder?.name ?? '',
			})
		"
		:confirm-text="t('components.postbox.postboxFolderRail.deleteFolder')"
		@update:open="
			(v: boolean) => {
				if (!v) deletingFolder = null;
			}
		"
		@confirm="confirmDeleteFolder"
	/>

	<PostboxLabelManager
		:mailbox-id="mailboxId"
		:open="labelManagerOpen"
		@update:open="labelManagerOpen = $event"
	/>
</template>
