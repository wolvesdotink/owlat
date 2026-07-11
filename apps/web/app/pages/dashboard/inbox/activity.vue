<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'All activity — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox',
});

// Global cross-channel activity feed: the newest messages across every channel
// (email / sms / whatsapp / chat / generic), newest-first, with a server-side
// channel filter. This is the global counterpart to the per-contact unified
// timeline — it consumes `unifiedMessages.listRecent`. Rows link into their
// conversation thread and carry hover-reveal actions (open / assign / resolve);
// the channel filter pills carry a per-channel health dot.
const {
	timeline,
	isLoading,
	error,
	channelFilter,
	channels,
	channelIcon,
	channelLabel,
	channelColor,
	channelHealth,
	directionIcon,
	directionLabel,
	deliveryStatusMeta,
	resolveThread,
	formatTime,
	truncate,
} = useChannelInbox();

// Managing channels (the empty-state CTA target) needs `organization:manage`;
// hide the affordance for editors — the explanation stays for everyone.
const { role } = useOrganizationContext();
const canManageChannels = computed(() => role.value === 'owner' || role.value === 'admin');

const activeFilterLabel = computed(() =>
	channelFilter.value ? channelLabel(channelFilter.value) : null
);

// Resolve in-flight guard so a double-click doesn't fire two mutations.
const resolvingId = ref<Id<'conversationThreads'> | null>(null);
async function handleResolve(threadId: Id<'conversationThreads'>) {
	if (resolvingId.value) return;
	resolvingId.value = threadId;
	await resolveThread(threadId);
	resolvingId.value = null;
}
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
			<div>
				<h1 class="text-2xl font-semibold text-text-primary">All activity</h1>
				<p class="text-text-secondary mt-1">Every message across email, SMS, WhatsApp and chat</p>
			</div>
		</div>

		<!-- Channel filter pills (with per-channel health dots) -->
		<div class="flex flex-wrap gap-2 mb-6">
			<button
				:class="[
					'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
					!channelFilter
						? 'bg-brand-subtle text-brand'
						: 'bg-bg-surface text-text-secondary hover:text-text-primary',
				]"
				@click="channelFilter = null"
			>
				All
			</button>
			<button
				v-for="ch in channels"
				:key="ch"
				:class="[
					'px-3 py-1.5 rounded-full text-xs font-medium transition-colors flex items-center gap-1.5',
					channelFilter === ch
						? 'bg-brand-subtle text-brand'
						: 'bg-bg-surface text-text-secondary hover:text-text-primary',
				]"
				@click="channelFilter = channelFilter === ch ? null : ch"
			>
				<Icon :name="channelIcon(ch)" class="w-3 h-3" />
				{{ channelLabel(ch) }}
				<span
					v-if="channelHealth(ch)"
					class="w-1.5 h-1.5 rounded-full"
					:class="channelHealth(ch)!.dotClass"
					:title="`${channelLabel(ch)}: ${channelHealth(ch)!.label}`"
				/>
			</button>
		</div>

		<UiQueryBoundary
			:loading="isLoading && !timeline.length"
			:error="error"
			error-title="Couldn't load activity"
		>
			<template #loading>
				<div class="flex items-center justify-center py-16">
					<div class="flex flex-col items-center gap-3">
						<UiSpinner />
						<p class="text-text-secondary text-sm">Loading messages...</p>
					</div>
				</div>
			</template>

			<!-- Empty — guided CTA (admin-only button, explanation for everyone) -->
			<InboxActivityEmptyState
				v-if="timeline.length === 0"
				:filter-label="activeFilterLabel"
				:can-manage="canManageChannels"
			/>

			<!-- Message list -->
			<ul v-else class="space-y-2">
				<li v-for="item in timeline" :key="item._id" class="group relative">
					<NuxtLink
						:to="`/dashboard/inbox/${item.threadId}`"
						class="card !p-4 flex items-start gap-4 hover:border-brand transition-colors cursor-pointer block"
					>
						<!-- Channel icon -->
						<div
							class="flex-shrink-0 w-10 h-10 rounded-full bg-bg-surface flex items-center justify-center"
						>
							<Icon
								:name="channelIcon(item.channel)"
								class="w-5 h-5"
								:class="channelColor(item.channel)"
							/>
						</div>

						<!-- Content -->
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2 mb-0.5">
								<!-- Direction chip -->
								<span
									:class="[
										'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium',
										item.direction === 'inbound'
											? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400'
											: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400',
									]"
								>
									<Icon :name="directionIcon(item.direction)" class="w-3 h-3" />
									{{ directionLabel(item.direction) }}
								</span>

								<!-- Channel chip -->
								<UiBadge variant="neutral" size="sm">
									{{ channelLabel(item.channel) }}
								</UiBadge>

								<!-- Delivery state — one small mark, detail in its title (one-chip rule) -->
								<Icon
									v-if="deliveryStatusMeta(item.status)"
									:name="deliveryStatusMeta(item.status)!.icon"
									class="w-3.5 h-3.5"
									:class="deliveryStatusMeta(item.status)!.class"
									:title="deliveryStatusMeta(item.status)!.label"
								/>
							</div>

							<!-- Subject (for email) -->
							<p v-if="item.content.subject" class="text-text-primary text-sm font-medium">
								{{ item.content.subject }}
							</p>

							<!-- Content preview -->
							<p class="text-text-secondary text-sm mt-0.5">
								{{ truncate(item.content.text || '') }}
							</p>
						</div>

						<!-- Time (hidden under the action rail on hover/focus — zero layout shift) -->
						<p
							class="flex-shrink-0 text-text-tertiary text-xs transition-opacity motion-reduce:transition-none opacity-100 group-hover:opacity-0 group-focus-within:opacity-0"
						>
							{{ formatTime(item.createdAt) }}
						</p>
					</NuxtLink>

					<!-- Hover-reveal action rail: opacity-only overlay, pointer-events gated,
				     also revealed on keyboard focus-within. No DOM/layout shift. -->
					<div
						class="absolute top-1/2 right-4 -translate-y-1/2 flex items-center gap-1 rounded-lg border border-border-subtle bg-bg-elevated px-1 py-1 shadow-lg opacity-0 pointer-events-none transition-opacity motion-reduce:transition-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto"
					>
						<NuxtLink
							:to="`/dashboard/inbox/${item.threadId}`"
							class="btn btn-ghost btn-sm !px-2"
							title="Open conversation"
							aria-label="Open conversation"
						>
							<Icon name="lucide:arrow-up-right" class="w-4 h-4" />
						</NuxtLink>
						<NuxtLink
							:to="`/dashboard/inbox/${item.threadId}`"
							class="btn btn-ghost btn-sm !px-2"
							title="Assign to a teammate"
							aria-label="Assign to a teammate"
						>
							<Icon name="lucide:user-plus" class="w-4 h-4" />
						</NuxtLink>
						<button
							type="button"
							class="btn btn-ghost btn-sm !px-2"
							:disabled="resolvingId === item.threadId"
							title="Mark as resolved"
							aria-label="Mark as resolved"
							@click="handleResolve(item.threadId)"
						>
							<Icon name="lucide:check-circle" class="w-4 h-4" />
						</button>
					</div>
				</li>
			</ul>
		</UiQueryBoundary>
	</div>
</template>
