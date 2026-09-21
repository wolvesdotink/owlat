<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { ChannelHealthDot } from '~/utils/channelKinds';

const { t, te } = useI18n();

useHead({ title: () => t('dashboard.inbox.activity.pageTitle') });

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
	deliveryStatusMeta,
	resolveThread,
	formatTime,
	truncate,
} = useChannelInbox();

// Managing channels (the empty-state CTA target) needs `organization:manage`;
// hide the affordance for editors — the explanation stays for everyone.
const { role } = useOrganizationContext();
const canManageChannels = computed(() => role.value === 'owner' || role.value === 'admin');

// Permanently-failed inbound messages. The denormalized counter off
// `instanceSettings.inboxStats` — the same read four other dashboard cards
// already subscribe to, so the badge costs nothing new.
const { data: inboundStats } = useConvexQuery(api.inbox.queries.getInboundStats, () => ({}));
const failedCount = computed(() => inboundStats.value?.failed ?? 0);

// Channel / direction / delivery labels are translated here; the shared display
// helpers (`~/composables/useUnifiedContactTimeline`) stay plain constants, so an
// unknown value still falls back to its raw label instead of a key path.
const channelName = (channel: string): string => {
	const key = `dashboard.inbox.activity.channels.${channel}`;
	return te(key) ? t(key) : channelLabel(channel);
};
const directionName = (direction: string): string =>
	t(
		direction === 'inbound'
			? 'dashboard.inbox.activity.directions.inbound'
			: 'dashboard.inbox.activity.directions.outbound'
	);
const deliveryStatusName = (meta: { label: string }, status: string): string => {
	const key = `dashboard.inbox.activity.deliveryStatuses.${status}`;
	return te(key) ? t(key) : meta.label;
};
/**
 * The health dot's variant is the stable enum here; its `label` is the shared
 * registry's message key (or a `{ key, params }` pair), which stands in when
 * this page has no wording of its own for the variant.
 */
const healthName = (health: ChannelHealthDot): string => {
	const key = `dashboard.inbox.activity.health.${health.variant}`;
	if (te(key)) return t(key);
	return typeof health.label === 'string'
		? t(health.label)
		: t(health.label.key, health.label.params ?? {});
};

const activeFilterLabel = computed(() =>
	channelFilter.value ? channelName(channelFilter.value) : null
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
				<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
					{{ t('dashboard.inbox.activity.title') }}
				</h1>
				<p class="text-text-secondary mt-1">{{ t('dashboard.inbox.activity.subtitle') }}</p>
			</div>

			<!-- The retry desk, which had no entrance at all: /dashboard/inbox/failed
			     was reachable only by typing the URL. This is the page where you come
			     to ask what the channels have been doing, so it is where the messages
			     that never made it belong — with a live count, like the review queue's
			     button on the inbox list. -->
			<UiButton
				variant="secondary"
				to="/dashboard/inbox/failed"
				class="gap-2"
				:title="t('dashboard.inbox.activity.failedMessagesTitle')"
			>
				<Icon name="lucide:alert-triangle" class="w-4 h-4" />
				{{ t('dashboard.inbox.activity.failedMessages') }}
				<UiBadge v-if="failedCount" variant="error" size="sm">{{ failedCount }}</UiBadge>
			</UiButton>
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
				{{ t('common.all') }}
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
				{{ channelName(ch) }}
				<span
					v-if="channelHealth(ch)"
					class="w-1.5 h-1.5 rounded-full"
					:class="channelHealth(ch)!.dotClass"
					:title="
						t('dashboard.inbox.activity.channelHealthTitle', {
							channel: channelName(ch),
							status: healthName(channelHealth(ch)!),
						})
					"
				/>
			</button>
		</div>

		<UiQueryBoundary
			:loading="isLoading && !timeline.length"
			:error="error"
			:empty="timeline.length === 0"
			:error-title="t('dashboard.inbox.activity.errorTitle')"
			:loading-label="t('dashboard.inbox.activity.loadingLabel')"
		>
			<!-- Empty — guided CTA (admin-only button, explanation for everyone) -->
			<template #empty>
				<InboxActivityEmptyState
					:filter-label="activeFilterLabel"
					:can-manage="canManageChannels"
				/>
			</template>

			<!-- Message list -->
			<ul class="space-y-2">
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
											? 'bg-info-subtle text-info'
											: 'bg-success-subtle text-success',
									]"
								>
									<Icon :name="directionIcon(item.direction)" class="w-3 h-3" />
									{{ directionName(item.direction) }}
								</span>

								<!-- Channel chip -->
								<UiBadge variant="neutral" size="sm">
									{{ channelName(item.channel) }}
								</UiBadge>

								<!-- Delivery state — one small mark, detail in its title (one-chip rule) -->
								<Icon
									v-if="deliveryStatusMeta(item.status)"
									:name="deliveryStatusMeta(item.status)!.icon"
									class="w-3.5 h-3.5"
									:class="deliveryStatusMeta(item.status)!.class"
									:title="deliveryStatusName(deliveryStatusMeta(item.status)!, item.status ?? '')"
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

					<!-- Hover-reveal action rail: Open and Resolve. There used to be a
					     third button here, an "assign" one that only navigated to the
					     thread — the same destination Open already has, under a verb it
					     did not do. Assigning happens in the thread header and on the
					     list row's own hover rail.
					     Opacity-only overlay, pointer-events gated, also revealed on
					     keyboard focus-within. No DOM/layout shift. -->
					<div
						class="absolute top-1/2 right-4 -translate-y-1/2 flex items-center gap-1 rounded-lg border border-border-subtle bg-bg-elevated px-1 py-1 shadow-lg opacity-0 pointer-events-none transition-opacity motion-reduce:transition-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto"
					>
						<UiButton
							variant="ghost"
							size="sm"
							:to="`/dashboard/inbox/${item.threadId}`"
							class="!px-2"
							:title="t('dashboard.inbox.activity.openConversation')"
							:aria-label="t('dashboard.inbox.activity.openConversation')"
						>
							<Icon name="lucide:arrow-up-right" class="w-4 h-4" />
						</UiButton>
						<UiButton
							variant="ghost"
							size="sm"
							type="button"
							class="!px-2"
							:disabled="resolvingId === item.threadId"
							:title="t('dashboard.inbox.activity.markAsResolved')"
							:aria-label="t('dashboard.inbox.activity.markAsResolved')"
							@click="handleResolve(item.threadId)"
						>
							<Icon name="lucide:check-circle" class="w-4 h-4" />
						</UiButton>
					</div>
				</li>
			</ul>
		</UiQueryBoundary>
	</div>
</template>
