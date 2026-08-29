<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { InboxThreadRowThread } from '~/components/inbox/InboxThreadRow.vue';
import { useOrganization } from '~/composables/useOrganization';
import {
	INBOX_FILTER_META,
	INBOX_SORT_META,
	nextInboxSort,
	type InboxFilter,
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
	filter,
	sort,
	toggleSort,
	filterCounts,
	threads,
	threadsLoading,
	threadsError,
	hasMoreThreads,
	stats,
	loadMoreThreads,
} = useInbox(computed(() => isAdmin.value));

// ── Row triage mutations (shared with the thread detail view) ──
const { user } = useAuth();
const { run: assignThread } = useBackendOperation(api.inbox.mutations.assignThread, {
	label: () => t('dashboard.inbox.index.assignThreadOperation'),
});
const { run: updateThreadStatus } = useBackendOperation(api.inbox.mutations.updateThreadStatus, {
	label: () => t('dashboard.inbox.index.updateThreadStatusOperation'),
});
const { run: snoozeThread } = useBackendOperation(api.inbox.snooze.snoozeThread, {
	label: () => t('dashboard.inbox.index.snoozeThreadOperation'),
});
const { run: unsnoozeThread } = useBackendOperation(api.inbox.snooze.unsnoozeThread, {
	label: () => t('dashboard.inbox.index.unsnoozeThreadOperation'),
});

type TeamThread = InboxThreadRowThread & { _id: Id<'conversationThreads'> };

// Filters whose rows require an open/waiting, not-snoozed thread — resolving or
// snoozing a row removes it from these, so those actions hide optimistically.
const ACTIVE_WORK_FILTERS = new Set<InboxFilter>([
	'open',
	'mine',
	'unassigned',
	'waiting',
	'waiting-24h',
]);

// Optimistic hide + one-slot undo toast (Cmd/Ctrl+Z), reusing the Postbox house
// composables. The list renders `visibleThreads`; a failed mutation restores the
// row and a successful one is undoable for ~8s.
const { visible: visibleThreads, run: runTriage } = useInboxTriage(
	threads as Ref<TeamThread[]>
);

// Org members for the row hover assignee picker (Me / members / Unassign).
const { members, fetchMembers } = useOrganization();
// Cmd/Ctrl+Z undoes the last triage while focus is outside any text field —
// usePostboxTriageUndo binds that listener app-wide while its stack is
// non-empty, so this page only has to register the actions.
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

/** Human undo-toast label for an assignment. */
function assignLabel(assignedTo: string | undefined): string {
	if (assignedTo === undefined) return t('dashboard.inbox.index.undo.unassigned');
	if (assignedTo === user.value?.id) return t('dashboard.inbox.index.undo.assignedToYou');
	const member = assignMembers.value.find((m) => m.userId === assignedTo);
	const name = member?.name || member?.email;
	return name
		? t('dashboard.inbox.index.undo.assignedTo', { name })
		: t('dashboard.inbox.index.undo.assigned');
}

/** Does assigning to `assignedTo` drop the row from the active filter? */
function assignLeavesView(assignedTo: string | undefined): boolean {
	if (filter.value === 'unassigned') return assignedTo !== undefined;
	if (filter.value === 'mine') return assignedTo !== user.value?.id;
	return false;
}

/** Assign/unassign a thread optimistically, with an undo that restores the prior owner. */
async function assignTo(thread: TeamThread, assignedTo: string | undefined) {
	const previous = thread.assignedTo ?? undefined;
	if (previous === assignedTo) return;
	await runTriage({
		id: thread._id,
		label: assignLabel(assignedTo),
		leavesView: assignLeavesView(assignedTo),
		mutate: () => assignThread({ threadId: thread._id, assignedTo }),
		inverse: () => assignThread({ threadId: thread._id, assignedTo: previous }),
	});
}

/** `i` claims the thread for the current user. */
async function assignToMe(thread: TeamThread) {
	const me = user.value?.id;
	if (!me) return;
	await assignTo(thread, me);
}

async function resolveThread(thread: TeamThread) {
	const previousStatus = thread.status;
	if (previousStatus === 'resolved') return;
	await runTriage({
		id: thread._id,
		label: t('dashboard.inbox.index.undo.resolved'),
		leavesView: ACTIVE_WORK_FILTERS.has(filter.value),
		mutate: () => updateThreadStatus({ threadId: thread._id, status: 'resolved' }),
		inverse: () => updateThreadStatus({ threadId: thread._id, status: previousStatus }),
	});
}

// Snooze picker — reuses the Postbox snooze presets (PostboxSnoozeDialog),
// bound to whichever row's Snooze quick-action opened it.
const showSnoozeDialog = ref(false);
const snoozeThreadId = ref<Id<'conversationThreads'> | null>(null);
function openSnooze(thread: TeamThread) {
	snoozeThreadId.value = thread._id;
	showSnoozeDialog.value = true;
}
async function onSnoozeConfirm(timestamp: number) {
	showSnoozeDialog.value = false;
	const id = snoozeThreadId.value;
	if (!id) return;
	await runTriage({
		id,
		label: t('dashboard.inbox.index.undo.snoozed'),
		leavesView: ACTIVE_WORK_FILTERS.has(filter.value),
		mutate: () => snoozeThread({ threadId: id, until: timestamp }),
		inverse: () => unsnoozeThread({ threadId: id }),
	});
}

// ── List keyboard: j/k move, Enter opens, i assigns-to-me. Shares the Postbox
// listbox composable so the conventions match. Reset focus on filter/sort. ──
const listKey = computed(() => `${filter.value}:${sort.value}`);
const { focusedIndex, activeId, onKeydown } = usePostboxListKeyboard<TeamThread>({
	items: visibleThreads,
	resetKey: listKey,
	rowDomId: (thread) => `inbox-row-${thread._id}`,
	onActivate: (thread) => navigateTo(`/dashboard/inbox/${thread._id}`),
	onAction: (key, thread) => {
		if (key === 'i' && isAdmin.value) void assignToMe(thread);
	},
});

// One ticking clock for the whole list: the waiting chips age in place without
// a reload, and a minute of drift is invisible on a chip that reads in hours.
// Deriving it per row would be one interval per visible thread.
const now = ref(Date.now());
let waitingClock: number | undefined;
onMounted(() => {
	waitingClock = window.setInterval(() => {
		now.value = Date.now();
	}, 60_000);
});
onUnmounted(() => {
	if (waitingClock !== undefined) window.clearInterval(waitingClock);
});

// Empty-state copy per active pill. The shared filter registry keeps its plain
// English fallback, so an unknown filter still reads as a sentence.
const emptyMessage = computed(() => {
	const key = `dashboard.inbox.index.empty.${filter.value}`;
	// The registry holds a KEY, not a sentence — resolve it rather than
	// rendering `shared.inboxFilters.…` at a person.
	return te(key) ? t(key) : t(INBOX_FILTER_META[filter.value].empty);
});
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
			<div>
				<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
					{{ t('dashboard.inbox.index.title') }}
				</h1>
				<p class="text-text-secondary mt-1">{{ t('dashboard.inbox.index.subtitle') }}</p>
			</div>

			<div class="flex items-center gap-3">
				<UiButton to="/dashboard/inbox/review" class="gap-2">
					<Icon name="lucide:check-circle" class="w-4 h-4" />
					{{ t('dashboard.inbox.index.reviewQueue') }}
					<span
						v-if="stats?.draftReady"
						class="ml-1 bg-text-inverse/20 text-text-inverse text-xs px-1.5 py-0.5 rounded-full"
					>
						{{ stats.draftReady }}
					</span>
				</UiButton>
			</div>
		</div>

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
				<InboxFilterPills v-model="filter" :counts="filterCounts" />

				<!-- The sort chip states the CURRENT order and cycles to the next
				     one; with three orders a toggle would have had to hide one. -->
				<button
					type="button"
					class="inline-flex items-center gap-1.5 text-xs text-text-tertiary hover:text-text-primary transition-colors duration-(--motion-fast) outline-none focus-visible:ring-1 focus-visible:ring-brand/50 rounded px-1.5 py-1"
					:title="
						t('dashboard.inbox.index.sortSwitchTo', {
							sort: t(INBOX_SORT_META[nextInboxSort(sort)].label),
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

			<!-- Loading — Postbox list skeleton geometry -->
			<UiQueryBoundary
				:loading="threadsLoading && threads.length === 0"
				:error="threadsError"
				:error-title="t('dashboard.inbox.index.errorTitle')"
			>
				<template #loading>
					<PostboxThreadListSkeleton :rows="8" />
				</template>

				<!-- Empty state — copy per active pill -->
				<div
					v-if="visibleThreads.length === 0"
					class="flex flex-col items-center justify-center py-16 text-center"
				>
					<UiIconBox icon="lucide:inbox" size="xl" variant="surface" rounded="full" class="mb-4" />
					<p class="text-text-secondary font-medium">{{ emptyMessage }}</p>
				</div>

				<!-- Thread List — Postbox row DNA: single column, weight-based unread,
			     one status chip, hover-reveal triage. Keyboard: j/k/Enter + i. -->
				<div v-else>
					<ul
						role="listbox"
						tabindex="0"
						:aria-label="t('dashboard.inbox.index.listAriaLabel')"
						:aria-activedescendant="activeId"
						class="divide-y divide-border-subtle rounded-lg border border-border-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-brand/50"
						@keydown="onKeydown"
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
							@assign="assignTo(thread, $event)"
							@resolve="resolveThread(thread)"
							@snooze="openSnooze(thread)"
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
			:open="showSnoozeDialog"
			@update:open="showSnoozeDialog = $event"
			@confirm="onSnoozeConfirm"
		/>
	</div>
</template>
