<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { ContextMenuItem } from '@owlat/ui/components/ui/ContextMenu.vue';
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

// Spam and Trash are destination folders you rarely browse, so they live in the
// "More" group with the rest of the long tail; everything else in the system set
// is a daily click and stays at the top of the rail.
const MORE_ROLES = new Set(['spam', 'trash']);
const primaryFolders = computed(() =>
	systemFolders.value.filter((folder) => !MORE_ROLES.has(folder.role ?? ''))
);
const moreFolders = computed(() =>
	systemFolders.value.filter((folder) => MORE_ROLES.has(folder.role ?? ''))
);

// Collapsible folder rail — icon strip when collapsed. Persisted per-device.
// forceExpanded (drawer staging) wins over the saved preference.
const { collapsed: savedCollapsed, toggle: toggleRail } = usePostboxRailCollapsed();
const railCollapsed = computed(() => !props.forceExpanded && savedCollapsed.value);

// Reply Queue rail badge (the count subscription is shared/deduped with the
// inbox strip in PostboxLayout).
const { count: replyQueueCount } = usePostboxReplyQueue(mailboxIdRef);

// Folder and label CRUD used to live on these rows as hover-revealed pencils
// and trashcans plus two header buttons. They are setup-time verbs, so they all
// moved into one "Manage folders & labels" dialog; the rail keeps only ENTRY
// points to it (the More group, and a right-click on any row).
const { openManager, pendingFolderDelete, requestFolderDelete, clearFolderDelete } =
	usePostboxManageDialog();
const folderActions = usePostboxFolderActions(mailboxIdRef);

/** Right-click on a custom-folder row. */
function folderMenuItems(folder: { _id: string; name: string }): ContextMenuItem[] {
	return [
		{
			id: 'rename',
			label: t('components.postbox.postboxFolderRail.renameFolder'),
			icon: 'lucide:pencil',
			run: () => openManager({ editFolderId: folder._id as Id<'mailFolders'> }),
		},
		{
			id: 'delete',
			label: t('components.postbox.postboxFolderRail.deleteFolder'),
			icon: 'lucide:trash-2',
			danger: true,
			run: () => requestFolderDelete({ _id: folder._id as Id<'mailFolders'>, name: folder.name }),
		},
		{
			id: 'new',
			label: t('components.postbox.postboxFolderRail.newFolder'),
			icon: 'lucide:folder-plus',
			separatorBefore: true,
			run: () => openManager({ section: 'folders', create: true }),
		},
		{
			id: 'manage',
			label: t('components.postbox.postboxLabelManager.title'),
			icon: 'lucide:settings-2',
			run: () => openManager({ section: 'folders' }),
		},
	];
}

// Deleting the folder you are reading has to take you somewhere; the rail is
// the surface that knows which folder that is, which is why the one
// confirmation dialog lives here rather than inside the manage dialog.
async function confirmDeleteFolder() {
	const folder = pendingFolderDelete.value;
	if (folder && (await folderActions.remove(folder._id)) && props.folderId === folder._id) {
		void navigateTo('/dashboard/postbox/inbox');
	}
	clearFolderDelete();
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
	     or the chevron at the bottom). Every row here is navigation: no folder
	     or label CRUD, no search box. Search is the app-wide overlay, on `/` and
	     Cmd/Ctrl+K; CRUD is the "Manage folders & labels" dialog, reachable from
	     "More" and from a right-click on any folder or label row. -->
	<aside
		class="border-r border-border-subtle bg-bg-elevated flex flex-col"
		:class="railCollapsed ? 'w-12 p-2 gap-1.5 items-center' : 'w-56 p-3 gap-2'"
	>
		<!-- Identity + the one primary verb. The mailbox switcher is a chip beside
		     Compose and renders nothing at all for a lone personal mailbox. -->
		<div :class="railCollapsed ? 'flex flex-col items-center gap-1.5' : 'flex items-center gap-2'">
			<PostboxComposeButton
				:mailbox-id="mailboxId"
				:collapsed="railCollapsed"
				:class="railCollapsed ? '' : 'flex-1 min-w-0'"
			/>
			<PostboxMailboxSwitcher :mailbox-id="mailboxId" :collapsed="railCollapsed" />
		</div>

		<PostboxFolderList
			:folders="primaryFolders"
			:unread-counts="unreadByRole"
			:active-folder="folderRole"
			:collapsed="railCollapsed"
		/>

		<!-- Reply Queue — the AI task list of emails waiting on a reply. A virtual
		     view like Snoozed (threads stay in their folders), but it carries a
		     live count and a workflow, so it stays out of "More". -->
		<PostboxRailLink
			to="/dashboard/postbox/reply-queue"
			icon="lucide:reply"
			:label="t('components.postbox.postboxFolderRail.replyQueue')"
			:collapsed="railCollapsed"
			:count="replyQueueCount"
			:count-label="
				t('components.postbox.postboxFolderRail.replyQueueAriaLabel', {
					count: replyQueueCount,
				})
			"
		/>

		<!-- Custom folders (no role; user-created or custom IMAP folders).
		     Expanded-only, and navigation only — right-click for the verbs. -->
		<div v-if="!railCollapsed" class="mt-3">
			<header class="flex items-center mb-1 px-2">
				<span class="text-xs font-semibold uppercase tracking-wider text-text-tertiary">{{
					t('components.postbox.postboxFolderRail.foldersHeading')
				}}</span>
			</header>
			<ul class="flex flex-col gap-0.5">
				<UiContextMenu
					v-for="folder in customFolders"
					:key="folder._id"
					:items="folderMenuItems(folder)"
				>
					<template #default="{ onContextmenu, onKeydown }">
						<li class="flex items-center" @contextmenu="onContextmenu" @keydown="onKeydown">
							<NuxtLink
								:to="`/dashboard/postbox/${folder._id}`"
								class="flex-1 flex items-center gap-2 px-2.5 py-1 rounded text-sm hover:bg-bg-surface min-w-0"
								:class="{ 'bg-bg-surface text-brand': folderId === folder._id }"
							>
								<Icon name="lucide:folder" class="w-4 h-4 flex-shrink-0" />
								<span class="truncate">{{ folder.name }}</span>
							</NuxtLink>
						</li>
					</template>
				</UiContextMenu>
				<li v-if="customFolders.length === 0" class="text-xs text-text-tertiary px-2 py-1">
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
						class="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 text-text-tertiary hover:text-text-primary"
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

		<!-- Labels, as navigation. Creating, renaming, recolouring, reordering and
		     deleting them all happen in the manage dialog; a right-click on a row
		     is the shortcut there. -->
		<div v-if="!railCollapsed" class="mt-3">
			<header class="flex items-center mb-1 px-2">
				<span class="text-xs font-semibold uppercase tracking-wider text-text-tertiary">{{
					t('components.postbox.postboxFolderRail.labelsHeading')
				}}</span>
			</header>
			<PostboxLabelTree :mailbox-id="mailboxId" :active-label-id="activeLabelId" />
		</div>

		<!-- The long tail: Spam, Trash, Snoozed, Files, Subscriptions, Contacts,
		     Import, Settings, and the manage surface. -->
		<PostboxRailMoreGroup
			class="mt-3"
			:collapsed="railCollapsed"
			:folders="moreFolders"
			:folder-role="folderRole"
		/>

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
		:open="!!pendingFolderDelete"
		variant="danger"
		:title="t('components.postbox.postboxFolderRail.deleteFolder')"
		:description="
			t('components.postbox.postboxFolderRail.deleteFolderDescription', {
				name: pendingFolderDelete?.name ?? '',
			})
		"
		:confirm-text="t('components.postbox.postboxFolderRail.deleteFolder')"
		@update:open="
			(v: boolean) => {
				if (!v) clearFolderDelete();
			}
		"
		@confirm="confirmDeleteFolder"
	/>

	<PostboxLabelManager :mailbox-id="mailboxId" />
</template>
