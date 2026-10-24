<script setup lang="ts">
import type { InboxThreadRowThread } from '~/components/inbox/InboxThreadRow.vue';
import InboxBulkBar from '~/components/inbox/InboxBulkBar.vue';
import { useOrganization } from '~/composables/useOrganization';
import { useInboxSelection } from '~/composables/useInboxSelection';
import {
	INBOX_ACTIVE_WORK_FILTERS,
	useInboxListActions,
	type InboxListThread,
} from '~/composables/useInboxListActions';
import { useInboxRowMenu } from '~/composables/useInboxRowMenu';
import { isChordPending, resolveActiveChord, resolveActiveShortcut } from '~/utils/shortcutScope';
import { useShortcutScope } from '~/composables/useShortcutScope';
import { teamThreadHasDraft, useComposerDrafts } from '~/composables/useComposerDrafts';
import {
	DEFAULT_INBOX_ASSIGNEE,
	DEFAULT_INBOX_FILTER,
	INBOX_FILTER_META,
	INBOX_SORT_META,
	isInboxSlaFilter,
	nextInboxSort,
} from '~/utils/inboxFilters';

const { t, te } = useI18n();

useHead({ title: () => t('dashboard.inbox.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox',
});

// ── Access gate ──
// The backend returns empty lists to non-admins by design; without this check
// that reads as "the queue is clear" when it actually means "no access". Once
// the role has resolved to a non-admin member, render the honest explainer
// (with exits) instead of a fake-zero inbox.
const { isAdmin, showAdminGate, role } = usePermissions();

// The role name is interpolated into user-facing copy, so it goes through the
// catalog rather than shipping the raw wire value into a translated sentence.
// An unknown role falls back to its own identifier over an inaccurate "member".
const displayRole = computed(() => {
	const current = role.value;
	if (!current) return t('common.roles.member');
	const key = `common.roles.${current}`;
	return te(key) ? t(key) : current;
});

const {
	// One ticking clock for the whole list: the waiting and deadline chips age in
	// place, in step with the Overdue / Due soon pills cut at the same clock.
	now,
	filter,
	assignee,
	mentions,
	unreadMentions,
	sort,
	setSort,
	toggleSort,
	filterCounts,
	slaSummary,
	isSlaEnabled,
	threads,
	threadsLoading,
	threadsError,
	retryThreads,
	hasMoreThreads,
	stats,
	loadMoreThreads,
} = useInbox(computed(() => isAdmin.value));

// ── Row triage (shared with the thread detail view) ──
const { user } = useAuth();
// The pencil on rows where the viewer left unsent text (this device).
const drafts = useComposerDrafts();

// Optimistic hide + undo toast (Cmd/Ctrl+Z), reusing the Postbox house
// composables. The list renders `visibleThreads`; a failed mutation restores the
// row and a successful one is undoable for ~8s.
const { visible: visibleThreads, run: runTriage } = useInboxTriage(
	threads as Ref<InboxListThread[]>
);

// The assignee-avatar presence ring and the note chip, read for the shown rows only.
const isAssigneePresent = useInboxAssigneePresence(visibleThreads);
const noteCountOf = useInboxNoteCounts(visibleThreads);

// Org members for the assignee pickers (Me / members / Unassign).
const { members, fetchMembers } = useOrganization();
onMounted(() => {
	void fetchMembers();
});
const assignMembers = computed(() =>
	members.value.map((m) => ({
		userId: m.userId,
		name: m.user.name,
		email: m.user.email,
		image: m.user.image,
	}))
);

// ── Selection: x toggles, Shift+click / Shift+J/K extend, Esc clears. A verb
// acts on the selection, or on the focused / clicked row when nothing is
// selected. A change of view starts from an empty selection. ──
const listKey = computed(() => `${filter.value}:${assignee.value}:${sort.value}:${mentions.value}`);
const selection = useInboxSelection({ rows: visibleThreads, resetKey: listKey });
const actions = useInboxListActions({
	runTriage,
	filter,
	assignee,
	members: assignMembers,
	// A verb on the selection leaves exactly its failures selected, to retry.
	captureSelection: (targets) => selection.captureSettle(targets.map((row) => row._id)),
});

// The assignee pickers: one per row (its hover cluster) and the bulk bar's.
// Opening either captures its targets; at most one is open at a time.
const assignRowId = ref<string | null>(null);
const bulkAssignOpen = ref(false);
function openAssign(row: InboxListThread, targets: InboxListThread[]) {
	actions.openAssign(targets);
	const bulk = targets.length > 1 || selection.isSelected(row._id);
	bulkAssignOpen.value = bulk;
	assignRowId.value = bulk ? null : row._id;
}
function setBulkAssignOpen(open: boolean) {
	if (open) {
		actions.openAssign(selection.selectedRows.value);
		assignRowId.value = null;
	}
	bulkAssignOpen.value = open;
}
function setRowAssignOpen(row: InboxListThread, open: boolean) {
	if (open) {
		actions.openAssign([row]);
		bulkAssignOpen.value = false;
	}
	assignRowId.value = open ? row._id : null;
}
const rowMenuFor = useInboxRowMenu({
	canManage: isAdmin,
	targetsFor: selection.targetsFor,
	isSelected: selection.isSelected,
	toggleSelect: (row) => selection.toggle(row._id),
	assignToMe: (targets) => void actions.assignToMe(targets),
	openAssign,
	resolve: (targets) => void actions.resolve(targets),
	snooze: actions.openSnooze,
});
// The row hands back the thread it was given, which is one of `visibleThreads`.
const rowMenu = (thread: InboxThreadRowThread) => rowMenuFor(thread as InboxListThread);

// ── List keyboard: j/k move, Enter opens, and the triage keys. Shares the
// Postbox listbox composable so the conventions match. Every key of the list
// lives in ONE scope (`inboxList`), so a remap that would put "assign" on the
// key that moves the list is refused, and claiming it puts the list's keys on
// the "?" sheet. ──
useShortcutScope('inboxList');
/**
 * The list's triage keys: on the selection when there is one, else on `row`.
 * Reports whether the key was one of them.
 */
function runListKey(id: string | null, row: InboxListThread | undefined): boolean {
	const targets = selection.count.value > 0 ? selection.selectedRows.value : row ? [row] : [];
	const anchor = row ?? targets[0];
	if (!anchor) return false;
	switch (id) {
		case 'inboxList.assignToMe':
			void actions.assignToMe(targets);
			return true;
		case 'inboxList.resolve':
			void actions.resolve(targets);
			return true;
		case 'inboxList.snooze':
			actions.openSnooze(targets);
			return true;
		case 'inboxList.assign':
			openAssign(anchor, targets);
			return true;
	}
	return false;
}

const { focusedIndex, activeId, onKeydown } = usePostboxListKeyboard<InboxListThread>({
	items: visibleThreads,
	resetKey: listKey,
	rowDomId: (thread) => `inbox-row-${thread._id}`,
	scope: 'inboxList',
	onActivate: (thread) => navigateTo(`/dashboard/inbox/${thread._id}`),
	onExtendSelection: (to, from) => {
		if (isAdmin.value) selection.extendTo(to._id, from?._id);
	},
	onAction: (key, thread) => {
		if (!isAdmin.value) return;
		const id = resolveActiveChord(key, ['inboxList']);
		if (id === 'inboxList.toggleSelect') selection.toggle(thread._id);
		else runListKey(id, thread);
	},
});

/**
 * The menu key (or a keyboard `contextmenu`, which reports no pointer) on the
 * list opens the focused row's menu, as a right-click on that row would.
 */
function openFocusedRowMenu(event: Event): boolean {
	if (event.target !== event.currentTarget) return false;
	if (event instanceof MouseEvent && (event.clientX !== 0 || event.clientY !== 0)) return false;
	const row = activeId.value ? document.getElementById(activeId.value)?.closest('li') : null;
	if (!row) return false;
	event.preventDefault();
	row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
	return true;
}

/**
 * Enter and Space on a control inside a row (the checkbox, a quick action, the
 * row's own link) belong to that control: its native activation acts on its own
 * row, so the list must not also act on the focused one, whatever the keys are
 * mapped to.
 */
function isControlActivation(event: KeyboardEvent): boolean {
	return event.target !== event.currentTarget && (event.key === 'Enter' || event.key === ' ');
}

function onListKeydown(event: KeyboardEvent) {
	if (isControlActivation(event)) return;
	const isMenuKey = event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
	if (isMenuKey && openFocusedRowMenu(event)) return;
	if (!event.defaultPrevented && !isChordPending() && isAdmin.value && selection.count.value > 0) {
		const id = resolveActiveShortcut(event, ['inboxList']);
		// Escape lets go of the selection before anything else hears it.
		if (id === 'inboxList.clearSelection') {
			event.preventDefault();
			selection.clear();
			return;
		}
		// A selection made with the mouse leaves no focused row for the list's
		// own handler to pass on; the verb still has its rows.
		if (focusedIndex.value < 0 && runListKey(id, undefined)) {
			event.preventDefault();
			return;
		}
	}
	onKeydown(event);
}

// Empty-state copy per active tab + assignment. An assignment on an active tab
// has its own sentence ("Nothing is assigned to you right now."); otherwise the
// tab's. The registry holds a KEY, not a sentence — resolve it rather than
// rendering `shared.inboxFilters.…` at a person.
const emptyMessage = computed(() => {
	if (mentions.value) return t('dashboard.inbox.index.empty.mentions');
	if (assignee.value !== DEFAULT_INBOX_ASSIGNEE && INBOX_ACTIVE_WORK_FILTERS.has(filter.value)) {
		return t(`dashboard.inbox.index.empty.${assignee.value}`);
	}
	const key = `dashboard.inbox.index.empty.${filter.value}`;
	return te(key) ? t(key) : t(INBOX_FILTER_META[filter.value].empty);
});

// A non-default tab or assignment hides rows that exist, which is a no-results
// state — the empty state says so and offers the way back rather than a dead
// end. The default view (Open, anyone) running empty is inbox zero: good news.
const isFiltered = computed(
	() =>
		mentions.value ||
		filter.value !== DEFAULT_INBOX_FILTER ||
		assignee.value !== DEFAULT_INBOX_ASSIGNEE
);
function clearFilters() {
	mentions.value = false;
	filter.value = DEFAULT_INBOX_FILTER;
	assignee.value = DEFAULT_INBOX_ASSIGNEE;
}

// "Waiting over 24h" is a highlight inside Open rather than a tab: how many
// customers have waited on us for more than a day, and a one-tap switch to the
// order that puts them first.
const waitingOver24h = computed(() => {
	if (filter.value !== 'open' || mentions.value) return 0;
	return filterCounts.value?.waitingOver24h ?? 0;
});
const showOldestFirst = () => setSort('oldest-waiting');
</script>

<template>
	<div class="mx-auto w-full max-w-page p-6 lg:p-8">
		<UiPageHeader
			class="mb-6"
			:title="t('dashboard.inbox.index.title')"
			:description="t('dashboard.inbox.index.subtitle')"
		>
			<template #actions>
				<UiButton v-if="isAdmin" to="/dashboard/inbox/analytics" variant="secondary" class="gap-2">
					<Icon name="lucide:bar-chart-3" class="w-4 h-4" />
					{{ t('dashboard.inbox.index.analytics') }}
				</UiButton>
				<!-- The one answer queue, filtered to this inbox. -->
				<UiButton to="/dashboard/answer?in=team" class="gap-2">
					<Icon name="lucide:check-circle" class="w-4 h-4" />
					{{ t('dashboard.inbox.index.reviewQueue') }}
					<span
						v-if="stats?.draftReady"
						class="ml-1 bg-text-inverse/20 text-text-inverse text-xs px-1.5 py-0.5 rounded-full"
					>
						{{ stats.draftReady }}
					</span>
				</UiButton>
			</template>
		</UiPageHeader>

		<!-- Access explainer: a non-admin on this route sees WHY it's empty and
		     where to go instead — never a fake "no conversations" zero. -->
		<div v-if="showAdminGate" class="flex flex-col items-center justify-center py-20 text-center">
			<UiIconBox icon="lucide:lock" size="xl" variant="warning" rounded="full" class="mb-4" />
			<h2 class="text-lg font-medium text-text-primary">
				{{ t('dashboard.inbox.index.accessTitle') }}
			</h2>
			<p class="text-text-secondary mt-1.5 max-w-md">
				{{ t('dashboard.inbox.index.accessBody', { role: displayRole }) }}
			</p>
			<div class="mt-6 flex flex-wrap items-center justify-center gap-3">
				<UiButton to="/dashboard/postbox/inbox" class="gap-2">
					<Icon name="lucide:inbox" class="w-4 h-4" />
					{{ t('dashboard.inbox.index.openMyPostbox') }}
				</UiButton>
			</div>
			<p class="text-xs text-text-tertiary mt-4">
				{{ t('dashboard.inbox.index.accessHint') }}
			</p>
		</div>

		<template v-else>
			<!-- Filter pills (live counts) + needs-attention sort chip -->
			<div class="flex flex-wrap items-center justify-between gap-3 mb-6">
				<InboxFilterPills
					v-model="filter"
					v-model:assignee="assignee"
					v-model:mentions="mentions"
					:counts="filterCounts"
					:unread-mentions="unreadMentions"
					:sla="slaSummary"
				/>

				<!-- The sort chip states the CURRENT order and cycles to the next
				     one; with three orders a toggle would have had to hide one. The
				     Mentions view and the response-target slices keep their own order
				     (newest mention, earliest deadline). -->
				<button
					v-if="!mentions && !isInboxSlaFilter(filter)"
					type="button"
					class="inline-flex items-center gap-1.5 text-xs text-text-tertiary hover:text-text-primary transition-colors duration-(--motion-fast) outline-none focus-visible:ring-1 focus-visible:ring-brand/50 rounded px-1.5 py-1"
					:title="
						t('dashboard.inbox.index.sortSwitchTo', {
							sort: t(INBOX_SORT_META[nextInboxSort(sort, isSlaEnabled)].label),
						})
					"
					@click="toggleSort"
				>
					<Icon :name="INBOX_SORT_META[sort].icon" class="w-3.5 h-3.5" />
					<span>
						{{ t('dashboard.inbox.index.sortedBy', { sort: t(INBOX_SORT_META[sort].label) }) }}
					</span>
				</button>
			</div>

			<!-- Waiting over 24h — a highlight within Open, not a tab. -->
			<p
				v-if="waitingOver24h > 0"
				class="-mt-3 mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary"
				data-testid="inbox-waiting-over-24h"
			>
				<Icon name="lucide:timer" class="w-4 h-4 text-warning shrink-0" aria-hidden="true" />
				<span>
					{{ t('dashboard.inbox.index.waitingOver24h', { count: waitingOver24h }, waitingOver24h) }}
				</span>
				<button
					v-if="sort !== 'oldest-waiting'"
					type="button"
					class="text-brand hover:underline"
					@click="showOldestFirst"
				>
					{{ t('dashboard.inbox.index.showLongestWaitFirst') }}
				</button>
			</p>

			<!-- Loading — Postbox list skeleton geometry -->
			<UiQueryBoundary
				:loading="threadsLoading && threads.length === 0"
				:error="threadsError"
				@retry="retryThreads"
				:empty="visibleThreads.length === 0"
				:error-title="t('dashboard.inbox.index.errorTitle')"
			>
				<template #loading>
					<PostboxThreadListSkeleton :rows="8" />
				</template>

				<!-- Empty state — copy per active pill. A non-default pill is a
				     no-results state, not an empty queue, so it reads quieter and
				     offers the way back to the full list. -->
				<template #empty>
					<UiEmptyState
						:icon="isFiltered ? 'lucide:inbox' : undefined"
						:title="emptyMessage"
						:variant="isFiltered ? 'no-results' : 'empty'"
						:tone="isFiltered ? 'default' : 'clear'"
						@clear="clearFilters"
					/>
				</template>

				<!-- Thread List — Postbox row DNA: single column, weight-based unread,
			     one status chip, hover-reveal triage, a row menu and swipe. -->
				<div>
					<InboxBulkBar
						v-if="isAdmin && selection.count.value > 0"
						:assign-open="bulkAssignOpen"
						:count="selection.count.value"
						:members="assignMembers"
						:current-user-id="user?.id ?? null"
						@update:assign-open="setBulkAssignOpen"
						@assign="actions.onAssignConfirm($event)"
						@resolve="actions.resolve(selection.selectedRows.value)"
						@snooze="actions.openSnooze(selection.selectedRows.value)"
						@clear="selection.clear()"
					/>
					<ul
						role="listbox"
						tabindex="0"
						:aria-label="t('dashboard.inbox.index.listAriaLabel')"
						:aria-activedescendant="activeId"
						:aria-multiselectable="isAdmin ? 'true' : undefined"
						class="divide-y divide-border-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-brand/50"
						@keydown="onListKeydown"
						@contextmenu="openFocusedRowMenu"
					>
						<InboxThreadRow
							v-for="(thread, index) in visibleThreads"
							:key="thread._id"
							:thread="thread"
							:focused="index === focusedIndex"
							:format-compact-relative-time="formatCompactRelativeTime"
							:members="assignMembers"
							:current-user-id="user?.id ?? null"
							:can-manage="isAdmin"
							:now="now"
							:assignee-present="isAssigneePresent(thread._id)"
							:note-count="noteCountOf(thread._id)"
							:has-draft="teamThreadHasDraft(drafts, thread._id)"
							:selected="selection.isSelected(thread._id)"
							:menu-items="rowMenu"
							:assign-open="assignRowId === thread._id"
							@update:assign-open="setRowAssignOpen(thread, $event)"
							@toggle-select="
								$event ? selection.extendTo(thread._id) : selection.toggle(thread._id)
							"
							@assign="actions.onAssignConfirm($event)"
							@resolve="actions.resolve([thread])"
							@snooze="actions.openSnooze([thread])"
						/>
					</ul>

					<!-- Load More -->
					<div v-if="hasMoreThreads" class="pt-4 text-center">
						<UiButton variant="secondary" size="sm" @click="loadMoreThreads">
							{{ t('dashboard.inbox.index.loadMore') }}
						</UiButton>
					</div>
				</div>
			</UiQueryBoundary>
		</template>

		<PostboxSnoozeDialog
			v-if="isAdmin"
			:open="actions.showSnoozeDialog.value"
			@update:open="actions.showSnoozeDialog.value = $event"
			@confirm="actions.onSnoozeConfirm"
		/>
	</div>
</template>
