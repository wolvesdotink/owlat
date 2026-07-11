<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { InboxThreadRowThread } from '~/components/inbox/InboxThreadRow.vue';
import { useOrganization } from '~/composables/useOrganization';
import { INBOX_FILTER_META } from '~/utils/inboxFilters';

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

type TeamThread = InboxThreadRowThread & { _id: Id<'conversationThreads'> };

// Org members for the row hover assignee picker (Me / members / Unassign).
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

/** `i` claims the thread for the current user. */
async function assignToMe(thread: TeamThread) {
	const me = user.value?.id;
	if (!me) return;
	await assignThread({ threadId: thread._id, assignedTo: me });
}

/** Hover picker choice — a specific member, or `undefined` to unassign. */
async function assignThreadTo(thread: TeamThread, assignedTo: string | undefined) {
	await assignThread({ threadId: thread._id, assignedTo });
}

async function resolveThread(thread: TeamThread) {
	await updateThreadStatus({ threadId: thread._id, status: 'resolved' });
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
	if (id) await snoozeThread({ threadId: id, until: timestamp });
}

// ── List keyboard: j/k move, Enter opens, i assigns-to-me. Shares the Postbox
// listbox composable so the conventions match. Reset focus on filter/sort. ──
const listKey = computed(() => `${filter.value}:${sort.value}`);
const { focusedIndex, activeId, onKeydown } = usePostboxListKeyboard<TeamThread>({
	items: threads as Ref<TeamThread[]>,
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
				v-if="threads.length === 0"
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
						v-for="(thread, index) in threads"
						:key="thread._id"
						:thread="thread"
						:focused="index === focusedIndex"
						:format-compact-relative-time="formatCompactRelativeTime"
						:members="assignMembers"
						:current-user-id="user?.id ?? null"
						@assign="assignThreadTo(thread, $event)"
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
