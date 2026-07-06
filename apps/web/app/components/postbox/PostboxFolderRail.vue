<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	folderRole: string;
	folderId?: Id<'mailFolders'>;
}>();

const mailboxIdRef = computed(() => props.mailboxId);
const { systemFolders, customFolders, unreadByRole } = usePostboxFolders(mailboxIdRef);
const { labels } = usePostboxLabels(mailboxIdRef);

// Collapsible folder rail — icon strip when collapsed. Persisted per-device.
const { collapsed: railCollapsed, toggle: toggleRail } = usePostboxRailCollapsed();

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

// Search entry point: a box in the folder rail + a "/" shortcut to focus it.
const searchQuery = ref('');
const searchBar = ref<{ focus: () => void } | null>(null);

function goSearch(value: string) {
	const q = value.trim();
	void navigateTo(
		q ? `/dashboard/postbox/search?q=${encodeURIComponent(q)}` : '/dashboard/postbox/search'
	);
}

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
	if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
	const el = event.target as HTMLElement | null;
	if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
		return;
	}
	event.preventDefault();
	searchBar.value?.focus();
}

// `/` pressed in the Today landing view: the layout flips to browse mode and
// arms this flag so the freshly mounted rail carries the intent through —
// search always lives here, never inside the Today column.
const searchAutofocus = useState('postbox:search-autofocus', () => false);

onMounted(() => {
	window.addEventListener('keydown', onGlobalKey);
	if (searchAutofocus.value) {
		searchAutofocus.value = false;
		void nextTick(() => searchBar.value?.focus());
	}
});
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey));
</script>

<template>
	<!-- Pane 1: folder rail — collapses to a ~48px icon strip (Cmd/Ctrl+Shift+D
	     or the chevron at the bottom). Collapsed hides folder CRUD, label
	     management and the search box; folder/action glyphs stay reachable. -->
	<aside
		class="border-r border-border-subtle bg-bg-elevated flex flex-col"
		:class="railCollapsed ? 'w-12 p-2 gap-1.5 items-center' : 'w-56 p-3 gap-2'"
	>
		<!-- Search: full box expanded; a single icon collapsed (opens the
		     search page, which hosts the palette/query UI). -->
		<PostboxSearchBar
			v-if="!railCollapsed"
			ref="searchBar"
			v-model="searchQuery"
			@submit="goSearch"
		/>
		<button
			v-else
			type="button"
			class="w-9 h-9 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface"
			title="Search"
			aria-label="Search"
			@click="goSearch('')"
		>
			<Icon name="lucide:search" class="w-4 h-4" />
		</button>
		<PostboxComposeButton :mailbox-id="mailboxId" :collapsed="railCollapsed" />
		<PostboxFolderList
			:folders="systemFolders"
			:unread-counts="unreadByRole"
			:active-folder="folderRole"
			:collapsed="railCollapsed"
		/>

		<!-- Reply Queue — AI task list of emails waiting on a reply (virtual
		     view like Snoozed; threads stay in their folders). -->
		<NuxtLink
			to="/dashboard/postbox/reply-queue"
			class="rounded text-sm hover:bg-bg-surface"
			:class="
				railCollapsed
					? 'relative flex items-center justify-center w-9 h-9'
					: 'flex items-center gap-2 px-2.5 py-1.5'
			"
			:title="railCollapsed ? 'Reply Queue' : undefined"
			:aria-label="
				railCollapsed
					? `Reply Queue${replyQueueCount > 0 ? `, ${replyQueueCount}` : ''}`
					: undefined
			"
		>
			<Icon name="lucide:reply" class="w-4 h-4" />
			<template v-if="!railCollapsed">
				<span class="flex-1">Reply Queue</span>
				<span v-if="replyQueueCount > 0" class="text-xs font-medium text-text-secondary">{{
					replyQueueCount
				}}</span>
			</template>
			<span
				v-else-if="replyQueueCount > 0"
				class="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-brand text-white text-[10px] leading-4 font-medium text-center"
				>{{ replyQueueCount > 99 ? '99+' : replyQueueCount }}</span
			>
		</NuxtLink>

		<!-- Virtual "Snoozed" view (no backing system folder; messages stay in
		     their origin folder, hidden until the wakeup cron). -->
		<NuxtLink
			to="/dashboard/postbox/snoozed"
			class="rounded text-sm hover:bg-bg-surface"
			:class="[
				railCollapsed
					? 'flex items-center justify-center w-9 h-9'
					: 'flex items-center gap-2 px-2.5 py-1.5',
				{ 'bg-bg-surface text-brand': folderRole === 'snoozed' },
			]"
			:title="railCollapsed ? 'Snoozed' : undefined"
			:aria-label="railCollapsed ? 'Snoozed' : undefined"
		>
			<Icon name="lucide:clock" class="w-4 h-4" />
			<span v-if="!railCollapsed" class="flex-1">Snoozed</span>
		</NuxtLink>
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
			:title="railCollapsed ? 'Contacts' : undefined"
			:aria-label="railCollapsed ? 'Contacts' : undefined"
		>
			<Icon name="lucide:users" :class="railCollapsed ? 'w-4 h-4' : 'w-3.5 h-3.5'" />
			<span v-if="!railCollapsed" class="flex-1">Contacts</span>
		</NuxtLink>

		<!-- Custom folders (no role; user-created or custom IMAP folders).
		     Expanded-only: folder CRUD and label management live here. -->
		<div v-if="!railCollapsed" class="mt-3">
			<header class="flex items-center justify-between mb-1 px-2">
				<span class="text-xs font-semibold uppercase tracking-wider text-text-tertiary"
					>Folders</span
				>
				<button
					type="button"
					class="text-text-tertiary hover:text-text-primary"
					title="New folder"
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
					placeholder="Folder name"
					class="w-full text-sm border border-border-subtle rounded px-2 py-1 bg-bg-surface text-text-primary"
					aria-label="New folder name"
					@keyup.enter="confirmCreateFolder"
					@keyup.esc="creatingFolder = false"
				/>
			</div>
			<ul class="flex flex-col gap-0.5">
				<li v-for="folder in customFolders" :key="folder._id" class="group flex items-center">
					<input
						v-if="renamingFolderId === folder._id"
						v-model="renameFolderName"
						class="flex-1 text-sm border border-border-subtle rounded px-2 py-1 bg-bg-surface text-text-primary mx-2"
						aria-label="Folder name"
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
							title="Rename folder"
							@click="startRenameFolder(folder)"
						>
							<Icon name="lucide:pencil" class="w-3 h-3" />
						</button>
						<button
							type="button"
							class="opacity-0 group-hover:opacity-100 p-1 text-text-tertiary hover:text-error"
							title="Delete folder"
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
					No custom folders
				</li>
			</ul>
		</div>

		<!-- Shown expanded so the "Manage labels" affordance (the only way to
		     create the first label) stays reachable; the empty case is handled
		     by the "No labels yet" row below. Collapsed hides labels with the
		     rest of the management UI. -->
		<div v-if="!railCollapsed" class="mt-3">
			<header class="flex items-center justify-between mb-1 px-2">
				<span class="text-xs font-semibold uppercase tracking-wider text-text-tertiary"
					>Labels</span
				>
				<button
					type="button"
					class="text-text-tertiary hover:text-text-primary"
					title="Manage labels"
					@click="labelManagerOpen = true"
				>
					<Icon name="lucide:settings-2" class="w-3.5 h-3.5" />
				</button>
			</header>
			<ul class="flex flex-col gap-0.5">
				<li v-for="label in labels" :key="label._id">
					<NuxtLink
						:to="`/dashboard/postbox/label/${label._id}`"
						class="flex items-center gap-2 px-2.5 py-1 rounded text-sm hover:bg-bg-surface"
					>
						<span
							class="w-2.5 h-2.5 rounded-full flex-shrink-0"
							:style="{ backgroundColor: label.color || '#6b7280' }"
						/>
						<span class="truncate">{{ label.name }}</span>
					</NuxtLink>
				</li>
				<li v-if="labels.length === 0" class="text-xs text-text-tertiary px-2 py-1">
					No labels yet
				</li>
			</ul>
		</div>

		<!-- Collapse toggle pinned to the rail bottom (also Cmd/Ctrl+Shift+D). -->
		<button
			type="button"
			class="mt-auto flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface"
			:class="railCollapsed ? 'w-9 h-9' : 'w-full gap-1.5 px-2.5 py-1.5 text-xs'"
			:title="railCollapsed ? 'Expand sidebar (Cmd+Shift+D)' : 'Collapse sidebar (Cmd+Shift+D)'"
			:aria-label="railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
			:aria-pressed="railCollapsed"
			@click="toggleRail"
		>
			<Icon
				:name="railCollapsed ? 'lucide:chevrons-right' : 'lucide:chevrons-left'"
				class="w-4 h-4"
			/>
			<span v-if="!railCollapsed">Collapse</span>
		</button>
	</aside>

	<UiConfirmationDialog
		:open="!!deletingFolder"
		variant="danger"
		title="Delete folder"
		:description="`Delete the folder &quot;${deletingFolder?.name ?? ''}&quot;? Messages in it are relocated, not deleted.`"
		confirm-text="Delete folder"
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
