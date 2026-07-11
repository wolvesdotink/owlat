<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { InboxThreadRowThread } from '~/components/inbox/InboxThreadRow.vue';
import { useOrganization } from '~/composables/useOrganization';
import { INBOX_FILTER_META, type InboxFilter } from '~/utils/inboxFilters';

useHead({ title: 'Team Inbox — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox',
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
} = useInbox();

// ── Row triage mutations (shared with the thread detail view) ──
const { user } = useAuth();
const { run: assignThread } = useBackendOperation(api.inbox.mutations.assignThread, {
	label: 'Assign thread',
});
const { run: updateThreadStatus } = useBackendOperation(api.inbox.mutations.updateThreadStatus, {
	label: 'Update thread status',
});
const { run: snoozeThread } = useBackendOperation(api.inbox.snooze.snoozeThread, {
	label: 'Snooze thread',
});
const { run: unsnoozeThread } = useBackendOperation(api.inbox.snooze.unsnoozeThread, {
	label: 'Unsnooze thread',
});

type TeamThread = InboxThreadRowThread & { _id: Id<'conversationThreads'> };

// Filters whose rows require an open/waiting, not-snoozed thread — resolving or
// snoozing a row removes it from these, so those actions hide optimistically.
const ACTIVE_WORK_FILTERS = new Set<InboxFilter>(['open', 'mine', 'unassigned', 'waiting']);

// Optimistic hide + one-slot undo toast (Cmd/Ctrl+Z), reusing the Postbox house
// composables. The list renders `visibleThreads`; a failed mutation restores the
// row and a successful one is undoable for ~8s.
const {
	visible: visibleThreads,
	run: runTriage,
	onWindowKeydown: onTriageUndoKeydown,
} = useInboxTriage(threads as Ref<TeamThread[]>);

// Org members for the row hover assignee picker (Me / members / Unassign).
const { members, fetchMembers } = useOrganization();
onMounted(() => {
	void fetchMembers();
	// Cmd/Ctrl+Z undoes the last triage while focus is outside any text field.
	window.addEventListener('keydown', onTriageUndoKeydown);
});
onBeforeUnmount(() => {
	window.removeEventListener('keydown', onTriageUndoKeydown);
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
	if (assignedTo === undefined) return 'Unassigned';
	if (assignedTo === user.value?.id) return 'Assigned to you';
	const member = assignMembers.value.find((m) => m.userId === assignedTo);
	const name = member?.name || member?.email;
	return name ? `Assigned to ${name}` : 'Assigned';
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
		label: 'Resolved',
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
		label: 'Snoozed',
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
	rowDomId: (t) => `inbox-row-${t._id}`,
	onActivate: (t) => navigateTo(`/dashboard/inbox/${t._id}`),
	onAction: (key, t) => {
		if (key === 'i') void assignToMe(t);
	},
});

const emptyMessage = computed(() => INBOX_FILTER_META[filter.value].empty);
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
			<div>
				<h1 class="text-2xl font-semibold text-text-primary">Team Inbox</h1>
				<p class="text-text-secondary mt-1">Customer conversations your team handles together.</p>
			</div>

			<div class="flex items-center gap-3">
				<NuxtLink to="/dashboard/inbox/review" class="btn btn-primary gap-2">
					<Icon name="lucide:check-circle" class="w-4 h-4" />
					Review Queue
					<span
						v-if="stats?.draftReady"
						class="ml-1 bg-white/20 text-white text-xs px-1.5 py-0.5 rounded-full"
					>
						{{ stats.draftReady }}
					</span>
				</NuxtLink>
			</div>
		</div>

		<!-- Filter pills (live counts) + needs-attention sort chip -->
		<div class="flex flex-wrap items-center justify-between gap-3 mb-6">
			<InboxFilterPills v-model="filter" :counts="filterCounts" />

			<button
				type="button"
				class="inline-flex items-center gap-1.5 text-xs text-text-tertiary hover:text-text-primary transition-colors duration-(--motion-fast) outline-none focus-visible:ring-1 focus-visible:ring-brand/50 rounded px-1.5 py-1"
				:title="
					sort === 'needs-attention'
						? 'Sorted by needs-attention — switch to newest first'
						: 'Sorted newest first — switch to needs-attention'
				"
				@click="toggleSort"
			>
				<Icon
					:name="sort === 'needs-attention' ? 'lucide:sparkles' : 'lucide:arrow-down-wide-narrow'"
					class="w-3.5 h-3.5"
				/>
				<span>{{ sort === 'needs-attention' ? 'Sorted by needs-attention' : 'Newest first' }}</span>
			</button>
		</div>

		<!-- Loading — Postbox list skeleton geometry -->
		<UiQueryBoundary
			:loading="threadsLoading && threads.length === 0"
			:error="threadsError"
			error-title="Couldn't load the inbox"
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
					aria-label="Team inbox threads"
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
						@assign="assignTo(thread, $event)"
						@resolve="resolveThread(thread)"
						@snooze="openSnooze(thread)"
					/>
				</ul>

				<!-- Load More -->
				<div v-if="hasMoreThreads" class="pt-4 text-center">
					<button class="btn btn-secondary btn-sm" @click="loadMoreThreads">Load More</button>
				</div>
			</div>
		</UiQueryBoundary>

		<PostboxSnoozeDialog
			:open="showSnoozeDialog"
			@update:open="showSnoozeDialog = $event"
			@confirm="onSnoozeConfirm"
		/>
	</div>
</template>
