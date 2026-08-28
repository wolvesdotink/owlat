<script setup lang="ts">
/**
 * The thread-list pane's header — folder title, cold-start "updating…" hint,
 * mobile drawer handle, the newest/oldest sort toggle, and (inbox only) the
 * Today jump + Flat/Conversations/Categories segmented control. Extracted from
 * PostboxLayout.vue (the plan's R8 list-header seam): pure presentation over
 * semantic emits — every action routes back to the layout's existing handlers.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { headerSelectionState } from '~/utils/postboxRangeSelect';

const { t } = useI18n();

const props = defineProps<{
	/** Resolved display name of the current folder (role label or custom name). */
	folderName: string;
	folderRole: string;
	folderId?: Id<'mailFolders'>;
	activeMessageId?: string | null;
	/** Cold start from the device cache — shows the quiet "updating…" shimmer. */
	showingCached?: boolean;
	isOffline?: boolean;
	/** Inbox-only view-mode control (Flat / Conversations / Categories). */
	viewMode?: string;
	viewModeOptions?: Array<{ value: string; label: string }>;
	/** Arrival direction of the list — 'newest' (default) or 'oldest'. */
	sortOrder?: string;
	/** Set on the flat list, which is the only renderer with a selection model. */
	mailboxId?: Id<'mailboxes'>;
	/** Ids of the rows the list currently has loaded, in render order. */
	pageIds?: string[];
	/**
	 * False when the rendered rows are a narrower set than the folder scope —
	 * i.e. a triage chip (unread / starred / attachments) is filtering the list.
	 * The whole-folder escape hatch below queries by folder scope alone, so
	 * under a chip it would silently select rows the chip is hiding. Absent
	 * means unfiltered, which is what every non-chip caller is.
	 */
	selectAllScopeMatchesList?: boolean;
}>();

// One toggle, two states: the label names the order the list is IN, and the
// title names the order a tap moves TO, so the control is never ambiguous
// about which it is describing.
const sortIsOldest = computed(() => props.sortOrder === 'oldest');

// --- Select-all -------------------------------------------------------------
// The header owns the checkbox that covers the whole page of rows, plus the
// escape hatch past it: the loaded page is 50 messages and "select all" over
// 4 000 is a different promise, so whole-folder selection goes through a
// server-side id query rather than pretending the page is the folder.
const mailboxIdRef = computed(() => props.mailboxId ?? null);
const bulk = usePostboxBulkActions(mailboxIdRef);
const pageIds = computed(() => props.pageIds ?? []);
const selectionEnabled = computed(() => props.mailboxId != null && pageIds.value.length > 0);
const selectionState = computed(() => headerSelectionState(pageIds.value, bulk.selected.value));

function toggleSelectPage() {
	if (selectionState.value === 'all') bulk.clear();
	else bulk.selectPage(pageIds.value as Id<'mailMessages'>[]);
}

const loadingAllMatching = ref(false);
/**
 * The escape hatch is only honest when the rows on screen ARE the folder
 * scope. `listMessageIds` narrows by folder, not by triage chip, so under an
 * active chip "select everything in this folder" would hand the next bulk verb
 * messages the user never saw as selected. Withhold it instead of lying: the
 * page-level selection (and its count) stays available.
 */
const canSelectAllMatching = computed(() => props.selectAllScopeMatchesList !== false);
/**
 * Replace the page selection with every message the current folder scope
 * holds. One-shot read, not a subscription: the answer is consumed once by the
 * bulk action that follows, and a live id list of a whole folder would re-run
 * on every arrival.
 */
async function selectAllMatching() {
	if (!props.mailboxId || loadingAllMatching.value || !canSelectAllMatching.value) return;
	loadingAllMatching.value = true;
	try {
		const result = await requireConvex().query(api.mail.mailbox.selection.listMessageIds, {
			mailboxId: props.mailboxId,
			...(props.folderId ? { folderId: props.folderId } : { folderRole: props.folderRole }),
			...(sortIsOldest.value ? { sortOrder: 'oldest' as const } : {}),
		});
		bulk.selectAllMatchingIds(result.ids, result.capped);
	} finally {
		loadingAllMatching.value = false;
	}
}

const emit = defineEmits<{
	/** Mobile drawer handle pressed — the layout owns the drawer state. */
	'open-rail': [];
	/** Back to the focused Today landing view. */
	'switch-today': [];
	'select-view-mode': [value: string];
	/** Flip the arrival direction (newest <-> oldest). */
	'toggle-sort': [];
}>();
</script>

<template>
	<!-- Wraps rather than truncates. The list pane is ~380px at a 1440px window,
	     which the folder title + sort toggle + view-mode control overflow: as one
	     nowrap row the title lost first and read "In…" for Inbox. Wrapping drops
	     the control cluster onto a second line only when it genuinely does not
	     fit, and a wide pane still gets the single row. -->
	<header
		class="border-b border-border-subtle px-4 py-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5"
	>
		<div class="flex items-center gap-2 min-w-0">
			<!-- Tri-state select-all over the rows that are loaded: unchecked,
			     a dash while some are picked, checked when the page is covered. -->
			<button
				v-if="selectionEnabled"
				type="button"
				role="checkbox"
				:aria-checked="
					selectionState === 'all' ? 'true' : selectionState === 'partial' ? 'mixed' : 'false'
				"
				class="w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
				:class="
					selectionState === 'none'
						? 'border-border-subtle bg-bg-base'
						: 'bg-brand border-brand text-text-inverse'
				"
				:aria-label="
					selectionState === 'all'
						? t('components.postbox.postboxListHeader.deselectPage')
						: t('components.postbox.postboxListHeader.selectPage')
				"
				:title="
					selectionState === 'all'
						? t('components.postbox.postboxListHeader.deselectPage')
						: t('components.postbox.postboxListHeader.selectPage')
				"
				@click="toggleSelectPage()"
			>
				<Icon
					v-if="selectionState !== 'none'"
					:name="selectionState === 'all' ? 'lucide:check' : 'lucide:minus'"
					class="w-3 h-3"
				/>
			</button>
			<!-- Drawer handle for the folder rail (mobile only). 44px square for
			     the thumb; the negative margins keep it from growing the header
			     past the height the 16px icon alone would give it. -->
			<button
				type="button"
				class="lg:hidden -ml-2 -my-2 w-11 h-11 flex items-center justify-center flex-shrink-0 rounded text-text-secondary hover:text-text-primary hover:bg-bg-base focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
				:aria-label="t('components.postbox.postboxLayout.openFolders')"
				@click="emit('open-rail')"
			>
				<Icon name="lucide:panel-left" class="w-4 h-4" />
			</button>
			<h2
				class="text-sm font-semibold capitalize text-text-primary flex items-center gap-2 min-w-0"
			>
				<span class="truncate">{{ folderName }}</span>
				<!-- Cold start from the device cache: a quiet "updating…" hint
				     while the live query catches up. Live rows replace in place.
				     Suppressed while offline: the live query never settles, so a
				     permanent "updating…" would read as stuck — the offline banner
				     already communicates the state. -->
				<span
					v-if="showingCached && !isOffline"
					class="animate-pulse motion-reduce:animate-none text-[11px] font-normal text-text-tertiary lowercase"
					>{{ t('components.postbox.postboxLayout.updating') }}</span
				>
			</h2>
		</div>
		<!-- `flex-shrink-0`: the cluster must wrap as a unit instead of squeezing
		     the segmented control until its labels collide. -->
		<div class="flex items-center gap-2 flex-shrink-0 ml-auto">
			<!-- Arrival direction. Every folder gets it: "oldest first" is how a
			     backlog gets cleared, and it was previously unreachable. -->
			<button
				type="button"
				class="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-base focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
				:title="
					sortIsOldest
						? t('components.postbox.postboxListHeader.sortToNewest')
						: t('components.postbox.postboxListHeader.sortToOldest')
				"
				:aria-label="
					sortIsOldest
						? t('components.postbox.postboxListHeader.sortToNewest')
						: t('components.postbox.postboxListHeader.sortToOldest')
				"
				@click="emit('toggle-sort')"
			>
				<Icon
					:name="sortIsOldest ? 'lucide:arrow-up-narrow-wide' : 'lucide:arrow-down-narrow-wide'"
					class="w-3.5 h-3.5"
					aria-hidden="true"
				/>
				<span class="hidden sm:inline">{{
					sortIsOldest
						? t('components.postbox.postboxListHeader.oldestFirst')
						: t('components.postbox.postboxListHeader.newestFirst')
				}}</span>
			</button>
			<template v-if="folderRole === 'inbox'">
				<!-- Back to the focused Today landing view (Esc / B do the same). -->
				<button
					v-if="!activeMessageId && !folderId"
					type="button"
					class="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-base focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
					aria-keyshortcuts="Escape b"
					:title="t('components.postbox.postboxLayout.backToTodayTitle')"
					@click="emit('switch-today')"
				>
					{{ t('common.today') }}
					<kbd
						class="text-[10px] text-text-tertiary border border-border-subtle rounded px-1"
						aria-hidden="true"
						>{{ t('components.postbox.postboxLayout.escKey') }}</kbd
					>
				</button>
				<!-- Labeled view-mode control — exactly one mode active; persisted
				     per user. Inbox-only: other folders stay flat. -->
				<UiSegmentedControl
					v-if="viewModeOptions"
					size="sm"
					:aria-label="t('components.postbox.postboxLayout.inboxView')"
					:options="viewModeOptions"
					:model-value="viewMode"
					@update:model-value="emit('select-view-mode', String($event))"
				/>
			</template>
		</div>
		<!-- Escape hatch past the loaded page. Only offered once the page itself
		     is fully selected, so it reads as "and the rest" rather than as a
		     second, competing select-all — and only while the page IS the folder
		     scope, since a triage chip makes "everything in this folder" a
		     different (larger) set than the one on screen. -->
		<div
			v-if="selectionEnabled && selectionState === 'all'"
			class="w-full text-xs text-text-secondary flex items-center gap-2"
			role="status"
		>
			<template v-if="bulk.selectAllMatching.value.active">
				<span>{{
					t(
						'components.postbox.postboxListHeader.allMatchingSelected',
						{ count: bulk.count.value },
						bulk.count.value
					)
				}}</span>
				<span v-if="bulk.selectAllMatching.value.capped" class="text-text-tertiary">{{
					t('components.postbox.postboxListHeader.allMatchingCapped', {
						count: bulk.count.value,
					})
				}}</span>
				<button type="button" class="text-brand hover:underline" @click="bulk.clear()">
					{{ t('components.postbox.postboxListHeader.clearSelection') }}
				</button>
			</template>
			<template v-else>
				<span>{{
					t(
						'components.postbox.postboxListHeader.pageSelected',
						{ count: bulk.count.value },
						bulk.count.value
					)
				}}</span>
				<button
					v-if="canSelectAllMatching"
					type="button"
					class="text-brand hover:underline disabled:opacity-50"
					:disabled="loadingAllMatching"
					@click="selectAllMatching()"
				>
					{{
						loadingAllMatching
							? t('components.postbox.postboxListHeader.selectingAllMatching')
							: t('components.postbox.postboxListHeader.selectAllMatching')
					}}
				</button>
			</template>
		</div>
	</header>
</template>
