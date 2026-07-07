<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { InboxThreadRowThread } from '~/components/inbox/InboxThreadRow.vue';

useHead({ title: 'Team Inbox — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox',
});

const {
	statusFilter,
	assignedToMe,
	threads,
	threadsLoading,
	hasMoreThreads,
	stats,
	statsLoading,
	loadMoreThreads,
	resetFilters,
	formatRelativeTime,
} = useInbox();

// `closed` is merged into `resolved` in the UI (single "Resolved" state); the
// filter no longer offers Closed. Legacy closed threads still read "Resolved"
// via the shared status chip.
const statusOptions: { value: string; label: string }[] = [
	{ value: '', label: 'All Statuses' },
	{ value: 'open', label: 'Open' },
	{ value: 'waiting', label: 'Waiting' },
	{ value: 'resolved', label: 'Resolved' },
];

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

/** `i` and the hover Assign action both claim the thread for the current user. */
async function assignToMe(thread: TeamThread) {
	const me = user.value?.id;
	if (!me) return;
	await assignThread({ threadId: thread._id, assignedTo: me });
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

// ── List keyboard: j/k move, Enter opens, i assigns-to-me (b4 fills the
// popover). Shares the Postbox listbox composable so the conventions match. ──
const filterKey = computed(() => `${statusFilter.value ?? ''}:${assignedToMe.value}`);
const { focusedIndex, activeId, onKeydown } = usePostboxListKeyboard<TeamThread>({
	items: threads as Ref<TeamThread[]>,
	resetKey: filterKey,
	rowDomId: (t) => `inbox-row-${t._id}`,
	onActivate: (t) => navigateTo(`/dashboard/inbox/${t._id}`),
	onAction: (key, t) => {
		if (key === 'i') void assignToMe(t);
	},
});
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
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

		<!-- Stats Grid -->
		<div v-if="stats" class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-4 mb-8">
			<div class="card !p-4 text-center">
				<p class="text-2xl font-semibold text-text-primary">{{ stats.total }}</p>
				<p class="text-xs text-text-tertiary mt-1">Total</p>
			</div>
			<div class="card !p-4 text-center">
				<p class="text-2xl font-semibold text-brand">{{ stats.openThreads }}</p>
				<p class="text-xs text-text-tertiary mt-1">Open Threads</p>
			</div>
			<div class="card !p-4 text-center">
				<p class="text-2xl font-semibold text-warning">{{ stats.draftReady }}</p>
				<p class="text-xs text-text-tertiary mt-1">Drafts Ready</p>
			</div>
			<div class="card !p-4 text-center">
				<p class="text-2xl font-semibold text-text-secondary">{{ stats.processing }}</p>
				<p class="text-xs text-text-tertiary mt-1">Processing</p>
			</div>
			<div class="card !p-4 text-center">
				<p class="text-2xl font-semibold text-success">{{ stats.approved }}</p>
				<p class="text-xs text-text-tertiary mt-1">Approved</p>
			</div>
			<div class="card !p-4 text-center">
				<p class="text-2xl font-semibold text-success">{{ stats.sent }}</p>
				<p class="text-xs text-text-tertiary mt-1">Sent</p>
			</div>
			<NuxtLink
				to="/dashboard/inbox/quarantine"
				class="card !p-4 text-center hover:border-error/30 transition-colors"
			>
				<p class="text-2xl font-semibold text-error">{{ stats.quarantined }}</p>
				<p class="text-xs text-text-tertiary mt-1">Quarantined</p>
			</NuxtLink>
			<NuxtLink
				to="/dashboard/inbox/failed"
				class="card !p-4 text-center hover:border-error/30 transition-colors"
			>
				<p class="text-2xl font-semibold text-error">{{ stats.failed }}</p>
				<p class="text-xs text-text-tertiary mt-1">Failed</p>
			</NuxtLink>
		</div>

		<!-- Filters -->
		<div class="flex flex-wrap items-center gap-3 mb-6">
			<select
				:value="statusFilter ?? ''"
				class="input w-auto"
				@change="
					statusFilter =
						(($event.target as HTMLSelectElement).value as 'open' | 'waiting' | 'resolved') ||
						undefined
				"
			>
				<option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">
					{{ opt.label }}
				</option>
			</select>

			<label class="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
				<input v-model="assignedToMe" type="checkbox" class="rounded border-border-subtle" />
				Assigned to me
			</label>

			<button
				v-if="statusFilter || assignedToMe"
				class="text-sm text-text-tertiary hover:text-text-primary transition-colors"
				@click="resetFilters"
			>
				Clear filters
			</button>
		</div>

		<!-- Loading -->
		<div
			v-if="threadsLoading && threads.length === 0"
			class="flex items-center justify-center py-16"
		>
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading threads...</p>
			</div>
		</div>

		<!-- Empty State -->
		<div
			v-else-if="threads.length === 0"
			class="flex flex-col items-center justify-center py-16 text-center"
		>
			<UiIconBox icon="lucide:inbox" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">No threads found</p>
			<p class="text-sm text-text-tertiary mt-1">
				{{
					statusFilter || assignedToMe
						? 'Try adjusting your filters.'
						: 'Inbound messages will appear here when they arrive.'
				}}
			</p>
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
					:format-relative-time="formatRelativeTime"
					@assign="assignToMe(thread)"
					@resolve="resolveThread(thread)"
					@snooze="openSnooze(thread)"
				/>
			</ul>

			<!-- Load More -->
			<div v-if="hasMoreThreads" class="pt-4 text-center">
				<button class="btn btn-secondary btn-sm" @click="loadMoreThreads">Load More</button>
			</div>
		</div>

		<PostboxSnoozeDialog
			:open="showSnoozeDialog"
			@update:open="showSnoozeDialog = $event"
			@confirm="onSnoozeConfirm"
		/>
	</div>
</template>
