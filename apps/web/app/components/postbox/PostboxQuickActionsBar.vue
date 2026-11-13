<script setup lang="ts">
/**
 * Bulk-actions toolbar that floats above the thread list when one or more
 * messages are selected. Hidden when nothing is selected.
 *
 * Five verbs are visible — Read/Unread, Star, Move, Archive, Delete — and the
 * weekly ones (Label, Snooze, Spam, Unsubscribe-and-archive, Delete forever)
 * live behind the one ⋯, which is the rule the composer footer already ships.
 * Delete is "move to Trash", so it stands down inside Trash itself, where the
 * overflow offers Delete forever instead: the set of verbs a folder can
 * actually run is unchanged, only where they are rendered.
 *
 * The whole-folder select-all hatch renders below the verbs, on the surface
 * that already says how many messages are selected.
 *
 * Over All inboxes and the unified folders (no `mailboxId`, a
 * `selectionScope` instead) the selection spans mailboxes, so the bar keeps
 * the verbs the server routes per message (read, star, archive, delete, and
 * Not spam and Delete forever where the folder has them) and leaves out the
 * ones that name one mailbox's folders or labels: Move, the overflow and the
 * whole-folder hatch.
 */

import type { Id } from '@owlat/api/dataModel';
import { useClickOutside } from '~/composables/useClickOutside';
import { useEscapeToClose } from '~/composables/useEscapeToClose';
import { postboxFolderLabel } from '~/composables/postbox/usePostboxFolderName';
import {
	ArchiveIcon,
	CloseIcon,
	FolderDownloadIcon,
	MailIcon,
	MailOpenIcon,
	ShieldCheckIcon,
	StarIcon,
	TrashIcon,
} from '@coolicons/vue';

const props = defineProps<{
	mailboxId?: Id<'mailboxes'>;
	/** The selection bucket when the list spans mailboxes (All inboxes). */
	selectionScope?: string;
	folderRole?: string;
	/** The list's arrival direction, for the whole-folder select-all query. */
	folderId?: Id<'mailFolders'>;
	sortOrder?: string;
	/** Ids of the rows the list currently has loaded, in render order. */
	pageIds?: string[];
	/** False while a triage chip narrows the list below the folder scope. */
	selectAllScopeMatchesList?: boolean;
}>();

const { t } = useI18n();

const mailboxIdRef = computed(() => props.mailboxId ?? null);
const bulk = usePostboxBulkActions(computed(() => props.selectionScope ?? props.mailboxId ?? null));
const { folders } = usePostboxFolders(mailboxIdRef);

const moveOpen = ref(false);
const moveWrapEl = ref<HTMLElement | null>(null);
const moveMenuEl = ref<HTMLElement | null>(null);
const confirm = useConfirm();

// The Move menu follows the menu-button pattern: Esc and an outside click
// close it, the first folder takes focus on open, and the arrows, Home and End
// move between folders.
useClickOutside(moveWrapEl, () => (moveOpen.value = false));
useEscapeToClose(moveOpen);
function moveItems(): HTMLElement[] {
	return Array.from(moveMenuEl.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
}
watch(moveOpen, async (open) => {
	if (!open) return;
	await nextTick();
	moveItems()[0]?.focus();
});
function onMoveMenuKeydown(event: KeyboardEvent) {
	const items = moveItems();
	if (items.length === 0) return;
	const current = items.indexOf(event.target as HTMLElement);
	let next: HTMLElement | undefined;
	if (event.key === 'ArrowDown') next = items[(current + 1) % items.length];
	else if (event.key === 'ArrowUp') next = items[(current - 1 + items.length) % items.length];
	else if (event.key === 'Home') next = items[0];
	else if (event.key === 'End') next = items[items.length - 1];
	else return;
	event.preventDefault();
	next?.focus();
}

// The same names the folder list and the move picker show for system
// folders. A custom folder keeps its own name.
function folderLabel(folder: { role?: string; name: string }): string {
	return postboxFolderLabel(t, folder);
}

/**
 * The selected ids that are rows of this view. The folder verbs below
 * (Delete forever, Not spam) are only right for rows the folder holds, so a
 * pick the list no longer shows is never sent along with them.
 */
function selectedInView(): Id<'mailMessages'>[] {
	const shown = new Set(props.pageIds ?? []);
	return bulk.ids.value.filter((id) => shown.has(id));
}

/** The overflow's Delete forever, for a selection that spans mailboxes. */
async function purgeAcrossMailboxes() {
	// The ids the question counted, not whatever is selected once it is answered.
	const messageIds = selectedInView();
	const n = messageIds.length;
	if (n === 0) return;
	const confirmed = await confirm({
		title: t('components.postbox.postboxQuickActionsBar.purgeConfirm', { count: n }, n),
		body: t('components.postbox.postboxQuickActionsBar.purgeConfirmBody'),
		confirmText: t('components.postbox.postboxQuickActionsBar.deleteForever'),
		variant: 'danger',
	});
	if (!confirmed) return;
	await bulk.purgeSelected(messageIds);
}

// Exclude the current folder and the non-destination system roles: moving a
// received message into Sent/Drafts mis-frames it as a sent/draft item.
const movableFolders = computed(() =>
	folders.value.filter((f) => {
		if (f.role === 'sent' || f.role === 'drafts') return false;
		if (props.folderRole && f.role === props.folderRole) return false;
		return true;
	})
);
</script>

<template>
	<Transition
		enter-active-class="transition-[opacity,translate] duration-(--motion-moderate)"
		enter-from-class="-translate-y-full opacity-0"
		enter-to-class="translate-y-0 opacity-100"
		leave-active-class="transition-[opacity,translate] duration-(--motion-moderate-exit)"
		leave-from-class="translate-y-0 opacity-100"
		leave-to-class="-translate-y-full opacity-0"
	>
		<div
			v-if="bulk.count.value > 0"
			class="sticky top-0 z-10 bg-bg-elevated border-b border-border-subtle shadow-sm"
		>
			<!-- Wraps inside the pane rather than bleeding across the reader: the
			     list pane is ~380px and six verbs plus the ⋯ and the dismiss do not
			     fit one nowrap row there. -->
			<div class="px-3 py-2 flex flex-wrap items-center gap-x-1 gap-y-1 text-sm">
				<span class="font-medium whitespace-nowrap">{{
					t('components.postbox.postboxQuickActionsBar.selected', { count: bulk.count.value })
				}}</span>
				<span class="w-px h-4 bg-border-subtle mx-1" />
				<UiTooltip :text="t('components.postbox.postboxQuickActionsBar.markReadTitle')">
					<UiButton
						variant="ghost"
						size="sm"
						class="gap-1.5 px-2 py-1"
						@click="bulk.markRead(true)"
					>
						<template #iconLeft>
							<MailOpenIcon class="w-4 h-4" />
						</template>
						{{ t('components.postbox.postboxQuickActionsBar.read') }}
					</UiButton>
				</UiTooltip>
				<UiTooltip :text="t('components.postbox.postboxQuickActionsBar.markUnreadTitle')">
					<UiButton
						variant="ghost"
						size="sm"
						class="gap-1.5 px-2 py-1"
						@click="bulk.markRead(false)"
					>
						<template #iconLeft>
							<MailIcon class="w-4 h-4" />
						</template>
						{{ t('components.postbox.postboxQuickActionsBar.unread') }}
					</UiButton>
				</UiTooltip>
				<UiTooltip :text="t('components.postbox.postboxQuickActionsBar.starTitle')">
					<UiButton variant="ghost" size="sm" class="gap-1.5 px-2 py-1" @click="bulk.star(true)">
						<template #iconLeft>
							<StarIcon class="w-4 h-4" />
						</template>
						{{ t('components.postbox.postboxQuickActionsBar.star') }}
					</UiButton>
				</UiTooltip>
				<span class="w-px h-4 bg-border-subtle mx-1" />
				<div v-if="mailboxId" ref="moveWrapEl" class="relative">
					<UiButton
						variant="ghost"
						size="sm"
						class="gap-1.5 px-2 py-1"
						aria-haspopup="menu"
						:aria-expanded="moveOpen"
						@click="moveOpen = !moveOpen"
					>
						<template #iconLeft>
							<FolderDownloadIcon class="w-4 h-4" />
						</template>
						{{ t('components.postbox.postboxQuickActionsBar.move') }}
					</UiButton>
					<div
						v-if="moveOpen"
						ref="moveMenuEl"
						role="menu"
						:aria-label="t('components.postbox.postboxQuickActionsBar.move')"
						class="absolute top-full mt-1 left-0 bg-bg-elevated border border-border-subtle rounded shadow-lg w-44 max-h-64 overflow-auto z-20"
						@keydown="onMoveMenuKeydown"
					>
						<button
							v-for="folder in movableFolders"
							:key="folder._id"
							type="button"
							role="menuitem"
							class="w-full text-left px-3 py-1.5 text-sm hover:bg-bg-surface focus-visible:bg-bg-surface focus-visible:outline-none"
							@click="
								bulk.moveSelected(folder._id, folder.role === 'trash');
								moveOpen = false;
							"
						>
							{{ folderLabel(folder) }}
						</button>
					</div>
				</div>
				<!-- Pushes the outcomes (archive / delete) away from the state verbs
				     on a wide pane, and folds away when the row wraps. -->
				<span class="flex-1 min-w-0" />
				<UiTooltip :text="t('components.postbox.postboxQuickActionsBar.archiveTitle')">
					<UiButton
						variant="ghost"
						size="sm"
						class="gap-1.5 px-2 py-1"
						@click="bulk.archiveSelected()"
					>
						<template #iconLeft>
							<ArchiveIcon class="w-4 h-4" />
						</template>
						{{ t('components.postbox.postboxQuickActionsBar.archive') }}
					</UiButton>
				</UiTooltip>
				<!-- "Delete" is "move to Trash"; inside Trash there is nowhere left to
				     move to, so the verb that folder DOES have (Delete forever, with
				     its confirm) is offered by the overflow instead. -->
				<UiTooltip
					v-if="props.folderRole !== 'trash'"
					:text="t('components.postbox.postboxQuickActionsBar.deleteTitle')"
				>
					<UiButton
						variant="danger-ghost"
						size="sm"
						class="gap-1.5 px-2 py-1"
						@click="bulk.trashSelected()"
					>
						<template #iconLeft>
							<TrashIcon class="w-4 h-4" />
						</template>
						{{ t('common.delete') }}
					</UiButton>
				</UiTooltip>
				<template v-if="!mailboxId">
					<UiTooltip
						v-if="props.folderRole === 'spam'"
						:text="t('components.postbox.postboxQuickActionsBar.notSpamTitle')"
					>
						<UiButton
							variant="ghost"
							size="sm"
							class="gap-1.5 px-2 py-1"
							@click="bulk.notSpamSelected(selectedInView())"
						>
							<template #iconLeft>
								<ShieldCheckIcon class="w-4 h-4" />
							</template>
							{{ t('components.postbox.postboxQuickActionsBar.notSpam') }}
						</UiButton>
					</UiTooltip>
					<UiTooltip
						v-if="props.folderRole === 'trash'"
						:text="t('components.postbox.postboxQuickActionsBar.deleteForeverTitle')"
					>
						<UiButton
							variant="danger-ghost"
							size="sm"
							class="gap-1.5 px-2 py-1"
							data-testid="bulk-delete-forever"
							@click="purgeAcrossMailboxes()"
						>
							<template #iconLeft>
								<TrashIcon class="w-4 h-4" />
							</template>
							{{ t('components.postbox.postboxQuickActionsBar.deleteForever') }}
						</UiButton>
					</UiTooltip>
				</template>
				<PostboxBulkOverflowMenu
					v-if="mailboxId"
					:mailbox-id="mailboxId"
					:folder-role="folderRole"
				/>
				<span class="w-px h-4 bg-border-subtle mx-1" />
				<UiTooltip :text="t('components.postbox.postboxQuickActionsBar.clearSelectionTitle')">
					<button
						type="button"
						class="p-1 rounded hover:bg-bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand inline-flex items-center justify-center pointer-coarse:min-h-11 pointer-coarse:min-w-11"
						:aria-label="t('components.postbox.postboxQuickActionsBar.clearSelectionTitle')"
						@click="bulk.clear()"
					>
						<CloseIcon class="w-4 h-4" />
					</button>
				</UiTooltip>
			</div>
			<PostboxBulkSelectAllRow
				v-if="mailboxId"
				:mailbox-id="mailboxId"
				:folder-role="folderRole"
				:folder-id="folderId"
				:sort-order="sortOrder"
				:page-ids="pageIds"
				:scope-matches-list="selectAllScopeMatchesList"
			/>
		</div>
	</Transition>
</template>
