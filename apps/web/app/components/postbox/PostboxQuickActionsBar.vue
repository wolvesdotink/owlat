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
 */

import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
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

const mailboxIdRef = computed(() => props.mailboxId);
const bulk = usePostboxBulkActions(mailboxIdRef);
const { folders } = usePostboxFolders(mailboxIdRef);

const moveOpen = ref(false);

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
		enter-active-class="transition-all duration-(--motion-moderate)"
		enter-from-class="-translate-y-full opacity-0"
		enter-to-class="translate-y-0 opacity-100"
		leave-active-class="transition-all duration-(--motion-moderate-exit)"
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
				<UiButton
					variant="ghost"
					size="sm"
					class="gap-1.5 px-2 py-1"
					:title="t('components.postbox.postboxQuickActionsBar.markReadTitle')"
					@click="bulk.markRead(true)"
				>
					<template #iconLeft>
						<Icon name="lucide:mail-open" class="w-4 h-4" />
					</template>
					{{ t('components.postbox.postboxQuickActionsBar.read') }}
				</UiButton>
				<UiButton
					variant="ghost"
					size="sm"
					class="gap-1.5 px-2 py-1"
					:title="t('components.postbox.postboxQuickActionsBar.markUnreadTitle')"
					@click="bulk.markRead(false)"
				>
					<template #iconLeft>
						<Icon name="lucide:mail" class="w-4 h-4" />
					</template>
					{{ t('components.postbox.postboxQuickActionsBar.unread') }}
				</UiButton>
				<UiButton
					variant="ghost"
					size="sm"
					class="gap-1.5 px-2 py-1"
					:title="t('components.postbox.postboxQuickActionsBar.starTitle')"
					@click="bulk.star(true)"
				>
					<template #iconLeft>
						<Icon name="lucide:star" class="w-4 h-4" />
					</template>
					{{ t('components.postbox.postboxQuickActionsBar.star') }}
				</UiButton>
				<span class="w-px h-4 bg-border-subtle mx-1" />
				<div class="relative">
					<UiButton
						variant="ghost"
						size="sm"
						class="gap-1.5 px-2 py-1"
						@click="moveOpen = !moveOpen"
					>
						<template #iconLeft>
							<Icon name="lucide:folder-input" class="w-4 h-4" />
						</template>
						{{ t('components.postbox.postboxQuickActionsBar.move') }}
					</UiButton>
					<div
						v-if="moveOpen"
						class="absolute top-full mt-1 left-0 bg-bg-elevated border border-border-subtle rounded shadow-lg w-44 max-h-64 overflow-auto z-20"
					>
						<button
							v-for="folder in movableFolders"
							:key="folder._id"
							type="button"
							class="w-full text-left px-3 py-1.5 text-sm hover:bg-bg-surface capitalize"
							@click="
								bulk.moveSelected(folder._id);
								moveOpen = false;
							"
						>
							{{ folder.role ?? folder.name }}
						</button>
					</div>
				</div>
				<!-- Pushes the outcomes (archive / delete) away from the state verbs
				     on a wide pane, and folds away when the row wraps. -->
				<span class="flex-1 min-w-0" />
				<UiButton
					variant="ghost"
					size="sm"
					class="gap-1.5 px-2 py-1"
					:title="t('components.postbox.postboxQuickActionsBar.archiveTitle')"
					@click="bulk.archiveSelected()"
				>
					<template #iconLeft>
						<Icon name="lucide:archive" class="w-4 h-4" />
					</template>
					{{ t('components.postbox.postboxQuickActionsBar.archive') }}
				</UiButton>
				<!-- "Delete" is "move to Trash"; inside Trash there is nowhere left to
				     move to, so the verb that folder DOES have (Delete forever, with
				     its confirm) is offered by the overflow instead. -->
				<UiButton
					v-if="props.folderRole !== 'trash'"
					variant="danger-ghost"
					size="sm"
					class="gap-1.5 px-2 py-1"
					:title="t('components.postbox.postboxQuickActionsBar.deleteTitle')"
					@click="bulk.trashSelected()"
				>
					<template #iconLeft>
						<Icon name="lucide:trash" class="w-4 h-4" />
					</template>
					{{ t('common.delete') }}
				</UiButton>
				<PostboxBulkOverflowMenu :mailbox-id="mailboxId" :folder-role="folderRole" />
				<span class="w-px h-4 bg-border-subtle mx-1" />
				<button
					type="button"
					class="p-1 rounded hover:bg-bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					:title="t('components.postbox.postboxQuickActionsBar.clearSelectionTitle')"
					@click="bulk.clear()"
				>
					<Icon name="lucide:x" class="w-4 h-4" />
				</button>
			</div>
			<PostboxBulkSelectAllRow
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
