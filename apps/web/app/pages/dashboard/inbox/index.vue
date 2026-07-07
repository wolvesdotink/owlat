<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

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

		<!-- Thread List -->
		<div v-else class="space-y-2">
			<NuxtLink
				v-for="thread in threads"
				:key="thread._id"
				:to="`/dashboard/inbox/${thread._id}`"
				class="card !p-4 flex items-center gap-4 hover:border-brand transition-colors cursor-pointer block"
			>
				<!-- Leading channel anchor (neutral — status lives in the one chip) -->
				<div
					class="flex-shrink-0 w-10 h-10 rounded-full bg-bg-surface flex items-center justify-center"
				>
					<Icon name="lucide:mail" class="w-5 h-5 text-text-tertiary" />
				</div>

				<!-- Thread info -->
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2">
						<p class="text-text-primary font-medium truncate">
							{{ thread.subject || 'No subject' }}
						</p>
						<!-- The single roll-up status chip (shared vocabulary) -->
						<InboxStatusChip
							class="flex-shrink-0"
							:status="thread.status"
							:latest-draft-status="thread.latestDraftStatus"
							:snoozed-until="thread.snoozedUntil"
							:snooze-returned-at="thread.snoozeReturnedAt"
						/>
					</div>
					<p class="text-sm text-text-secondary truncate mt-0.5">
						{{ thread.contactIdentifier || 'Unknown sender' }}
					</p>
				</div>

				<!-- Metadata -->
				<div class="flex-shrink-0 text-right">
					<p class="text-xs text-text-tertiary">
						{{ formatRelativeTime(thread.lastMessageAt ?? thread._creationTime) }}
					</p>
					<p class="text-xs text-text-tertiary mt-1">
						{{ thread.messageCount ?? 0 }}
						{{ (thread.messageCount ?? 0) === 1 ? 'message' : 'messages' }}
					</p>
				</div>
			</NuxtLink>

			<!-- Load More -->
			<div v-if="hasMoreThreads" class="pt-4 text-center">
				<button class="btn btn-secondary btn-sm" @click="loadMoreThreads">Load More</button>
			</div>
		</div>
	</div>
</template>
