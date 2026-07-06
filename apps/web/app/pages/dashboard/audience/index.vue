<script setup lang="ts">
import { api } from '@owlat/api';

useHead({ title: 'Audience — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Fetch audience stats
const { data: audienceStats, isLoading: statsLoading } = useOrganizationQuery(
	api.contacts.analytics.getAudienceStats
);

// Fetch subscriber growth (last 30 days)
const { data: subscriberGrowth, isLoading: growthLoading } = useOrganizationQuery(
	api.contacts.analytics.getSubscriberGrowth
);

// Fetch top topics
const { data: topLists, isLoading: listsLoading } = useOrganizationQuery(
	api.contacts.analytics.getTopTopics,
	{ limit: 5 }
);

// Fetch recent contacts
const { data: recentContacts, isLoading: contactsLoading } = useOrganizationQuery(
	api.contacts.analytics.getRecent,
	{ limit: 5 }
);

// Activity types for filtering
type ActivityType = 'topic_subscribed' | 'topic_unsubscribed' | 'topic_confirmed' | 'created';
const subscriberActivityTypes: ActivityType[] = [
	'topic_subscribed',
	'topic_unsubscribed',
	'topic_confirmed',
	'created',
];

// Fetch recent activity (topic changes and contact creation only)
const { data: recentActivity, isLoading: activityLoading } = useOrganizationQuery(
	api.contacts.activities.getRecent,
	{
		limit: 10,
		activityTypes: subscriberActivityTypes,
	}
);

// Stats for display
const stats = computed(() => [
	{
		label: 'Total Contacts',
		value: audienceStats.value?.totalContacts ?? 0,
		icon: 'lucide:users',
		color: 'brand',
	},
	{
		label: 'Topics',
		value: audienceStats.value?.topicCount ?? 0,
		icon: 'lucide:list-plus',
		color: 'brand',
	},
	{
		label: 'Segments',
		value: audienceStats.value?.segmentCount ?? 0,
		icon: 'lucide:filter',
		color: 'lavender',
	},
]);

// Quick actions
const quickActions = [
	{
		label: 'Add Contact',
		href: '/dashboard/audience/contacts?action=add',
		icon: 'lucide:user-plus',
		description: 'Manually add a new contact',
	},
	{
		label: 'Create Topic',
		href: '/dashboard/audience/topics?action=create',
		icon: 'lucide:list-plus',
		description: 'Create a new topic',
	},
	{
		label: 'Create Segment',
		href: '/dashboard/audience/segments?action=create',
		icon: 'lucide:filter',
		description: 'Build a dynamic audience segment',
	},
];

// Per-day buckets for the growth chart (the query now returns
// `{ days, truncated }`; `truncated` is true only for very large 30-day intakes).
const growthDays = computed(() => subscriberGrowth.value?.days ?? []);

// Per-day bars for the growth chart (UiBars); tooltips carry the full
// "Jun 5"-style label, the sparse axis shows every 5th.
const growthBars = computed(() =>
	growthDays.value.map((d: { label: string; count: number }) => ({
		label: d.label,
		value: d.count,
	}))
);

// Compute total new subscribers in last 30 days
const totalNewSubscribers = computed(() => {
	return growthDays.value.reduce((sum: number, d: { count: number }) => sum + d.count, 0);
});

// Get activity icon and color
function getActivityIcon(activityType: string) {
	switch (activityType) {
		case 'topic_subscribed':
			return { icon: 'lucide:user-plus', color: 'text-success' };
		case 'topic_unsubscribed':
			return { icon: 'lucide:user-minus', color: 'text-error' };
		case 'topic_confirmed':
			return { icon: 'lucide:user-check', color: 'text-success' };
		case 'created':
			return { icon: 'lucide:user-plus', color: 'text-brand' };
		default:
			return { icon: 'lucide:activity', color: 'text-text-secondary' };
	}
}

// Format activity description
function formatActivityDescription(activityType: string): string {
	switch (activityType) {
		case 'topic_subscribed':
			return 'was subscribed to a topic';
		case 'topic_unsubscribed':
			return 'was unsubscribed from a topic';
		case 'topic_confirmed':
			return 'confirmed subscription';
		case 'created':
			return 'was added';
		default:
			return activityType;
	}
}

// Get contact display name
function getContactName(
	contact: { email?: string; firstName?: string; lastName?: string } | null
): string {
	if (!contact) return 'Unknown';
	if (contact.firstName || contact.lastName) {
		return `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim();
	}
	return contact.email ?? 'Unknown';
}
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
			<div>
				<h1 class="text-2xl font-semibold text-text-primary">Audience</h1>
				<p class="mt-1 text-text-secondary">Manage your contacts, topics, and segments.</p>
			</div>
			<NuxtLink to="/dashboard/audience/contacts?action=add" class="btn btn-primary gap-2">
				<Icon name="lucide:plus" class="w-4 h-4" />
				Add Contact
			</NuxtLink>
		</div>

		<!-- Stats Cards -->
		<div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
			<div
				v-for="stat in stats"
				:key="stat.label"
				class="card group hover:border-border-default transition-colors"
			>
				<div class="flex items-start justify-between">
					<div>
						<p class="text-sm text-text-secondary">{{ stat.label }}</p>
						<div class="flex items-center gap-2 mt-1">
							<p v-if="statsLoading" class="text-3xl font-semibold text-text-tertiary">--</p>
							<p v-else class="text-3xl font-semibold text-text-primary">
								{{ stat.value.toLocaleString() }}
							</p>
							<Icon
								v-if="statsLoading"
								name="lucide:loader-2"
								class="w-4 h-4 animate-spin text-text-tertiary"
							/>
						</div>
					</div>
					<div
						:class="[
							'w-9 h-9 flex items-center justify-center rounded-xl',
							stat.color === 'brand'
								? 'bg-brand-subtle text-brand'
								: stat.color === 'success'
									? 'bg-success-subtle text-success'
									: stat.color === 'lavender'
										? 'bg-lavender-subtle text-lavender'
										: 'bg-bg-surface text-text-tertiary',
						]"
					>
						<Icon :name="stat.icon" class="w-5 h-5" />
					</div>
				</div>
			</div>
		</div>

		<!-- Quick Actions -->
		<div class="mb-8">
			<h2 class="text-lg font-semibold text-text-primary mb-4">Quick Actions</h2>
			<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<NuxtLink
					v-for="action in quickActions"
					:key="action.label"
					:to="action.href"
					class="card group hover:border-brand transition-colors cursor-pointer"
				>
					<div class="flex items-center gap-4">
						<UiIconBox
							:icon="action.icon"
							class="group-hover:bg-brand group-hover:text-text-inverse transition-colors"
						/>
						<div>
							<p class="font-medium text-text-primary group-hover:text-brand transition-colors">
								{{ action.label }}
							</p>
							<p class="text-sm text-text-tertiary">{{ action.description }}</p>
						</div>
					</div>
				</NuxtLink>
			</div>
		</div>

		<!-- Two column layout - Growth Chart and Top Topics -->
		<div class="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
			<!-- Subscriber Growth Chart (Last 30 Days) -->
			<div>
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-lg font-semibold text-text-primary flex items-center gap-2">
						<Icon name="lucide:trending-up" class="w-5 h-5 text-brand" />
						Subscriber Growth (30 days)
					</h2>
					<span class="text-sm text-text-secondary">
						+{{ totalNewSubscribers.toLocaleString() }} new
					</span>
				</div>
				<div class="card">
					<!-- Loading state -->
					<div v-if="growthLoading" class="flex items-center justify-center py-8">
						<Icon name="lucide:loader-2" class="w-6 h-6 animate-spin text-text-tertiary" />
					</div>

					<!-- Chart -->
					<UiBars
						v-else
						:data="growthBars"
						:height="128"
						:label-every="5"
						:format-value="(v: number) => `${v.toLocaleString()} new subscribers`"
						aria-label="New subscribers per day over the last 30 days"
					/>
				</div>
			</div>

			<!-- Top Topics -->
			<div>
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-lg font-semibold text-text-primary flex items-center gap-2">
						<Icon name="lucide:list-plus" class="w-5 h-5 text-brand" />
						Top Topics
					</h2>
					<NuxtLink
						to="/dashboard/audience/topics"
						class="text-sm text-brand hover:text-brand-hover flex items-center gap-1"
					>
						View all
						<Icon name="lucide:arrow-right" class="w-3 h-3" />
					</NuxtLink>
				</div>
				<div class="card">
					<!-- Loading state -->
					<div v-if="listsLoading" class="flex items-center justify-center py-8">
						<Icon name="lucide:loader-2" class="w-6 h-6 animate-spin text-text-tertiary" />
					</div>

					<!-- Empty state -->
					<div
						v-else-if="!topLists || topLists.length === 0"
						class="flex flex-col items-center justify-center py-12 text-center"
					>
						<UiIconBox
							icon="lucide:list-plus"
							size="xl"
							variant="surface"
							rounded="full"
							class="mb-4"
						/>
						<p class="text-text-secondary font-medium">No topics yet</p>
						<p class="text-sm text-text-tertiary mt-1 max-w-sm">
							Create a topic to organize your contacts.
						</p>
						<NuxtLink
							to="/dashboard/audience/topics?action=create"
							class="btn btn-primary mt-6 gap-2"
						>
							<Icon name="lucide:plus" class="w-4 h-4" />
							Create Topic
						</NuxtLink>
					</div>

					<!-- Topics -->
					<div v-else class="divide-y divide-border-subtle">
						<NuxtLink
							v-for="list in topLists"
							:key="list._id"
							:to="`/dashboard/audience/topics/${list._id}`"
							class="flex items-center gap-4 py-3 first:pt-0 last:pb-0 hover:bg-bg-surface -mx-4 px-4 transition-colors"
						>
							<UiIconBox icon="lucide:mail" size="sm" variant="surface" rounded="lg" />
							<div class="flex-1 min-w-0">
								<p class="text-sm text-text-primary truncate font-medium">
									{{ list.name }}
								</p>
								<p class="text-xs text-text-tertiary mt-0.5">
									{{ list.contactCount.toLocaleString() }} contacts
								</p>
							</div>
							<div class="text-right">
								<div class="w-16 h-2 bg-bg-surface rounded-full overflow-hidden">
									<div
										class="h-full bg-brand rounded-full"
										:style="{
											width: `${Math.min((list.contactCount / (audienceStats?.totalContacts || 1)) * 100, 100)}%`,
										}"
									/>
								</div>
							</div>
						</NuxtLink>
					</div>
				</div>
			</div>
		</div>

		<!-- Two column layout - Recent Contacts and Recent Activity -->
		<div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
			<!-- Recent Contacts -->
			<div>
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-lg font-semibold text-text-primary flex items-center gap-2">
						<Icon name="lucide:user-plus" class="w-5 h-5 text-brand" />
						Recently Added
					</h2>
					<NuxtLink
						to="/dashboard/audience/contacts"
						class="text-sm text-brand hover:text-brand-hover flex items-center gap-1"
					>
						View all
						<Icon name="lucide:arrow-right" class="w-3 h-3" />
					</NuxtLink>
				</div>
				<div class="card">
					<!-- Loading state -->
					<div v-if="contactsLoading" class="flex items-center justify-center py-8">
						<Icon name="lucide:loader-2" class="w-6 h-6 animate-spin text-text-tertiary" />
					</div>

					<!-- Empty state -->
					<div
						v-else-if="!recentContacts || recentContacts.length === 0"
						class="flex flex-col items-center justify-center py-12 text-center"
					>
						<UiIconBox
							icon="lucide:users"
							size="xl"
							variant="surface"
							rounded="full"
							class="mb-4"
						/>
						<p class="text-text-secondary font-medium">No contacts yet</p>
						<p class="text-sm text-text-tertiary mt-1 max-w-sm">
							Add your first contact to get started.
						</p>
						<NuxtLink
							to="/dashboard/audience/contacts?action=add"
							class="btn btn-primary mt-6 gap-2"
						>
							<Icon name="lucide:plus" class="w-4 h-4" />
							Add Contact
						</NuxtLink>
					</div>

					<!-- Contacts list -->
					<div v-else class="divide-y divide-border-subtle">
						<NuxtLink
							v-for="contact in recentContacts"
							:key="contact._id"
							:to="`/dashboard/audience/contacts/${contact._id}`"
							class="flex items-center gap-4 py-3 first:pt-0 last:pb-0 hover:bg-bg-surface -mx-4 px-4 transition-colors"
						>
							<UiIconBox icon="lucide:users" size="sm" variant="surface" rounded="lg" />
							<div class="flex-1 min-w-0">
								<p class="text-sm text-text-primary truncate font-medium">
									{{
										contact.firstName || contact.lastName
											? `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim()
											: contact.email
									}}
								</p>
								<p
									v-if="contact.firstName || contact.lastName"
									class="text-xs text-text-tertiary truncate"
								>
									{{ contact.email }}
								</p>
							</div>
						</NuxtLink>
					</div>
				</div>
			</div>

			<!-- Recent Activity -->
			<div>
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-lg font-semibold text-text-primary flex items-center gap-2">
						<Icon name="lucide:activity" class="w-5 h-5 text-brand" />
						Recent Activity
					</h2>
				</div>
				<div class="card">
					<!-- Loading state -->
					<div v-if="activityLoading" class="flex items-center justify-center py-8">
						<Icon name="lucide:loader-2" class="w-6 h-6 animate-spin text-text-tertiary" />
					</div>

					<!-- Empty state -->
					<div
						v-else-if="!recentActivity || recentActivity.length === 0"
						class="flex flex-col items-center justify-center py-12 text-center"
					>
						<UiIconBox
							icon="lucide:activity"
							size="xl"
							variant="surface"
							rounded="full"
							class="mb-4"
						/>
						<p class="text-text-secondary font-medium">No recent activity</p>
						<p class="text-sm text-text-tertiary mt-1 max-w-sm">
							Activity will appear here as contacts subscribe to or unsubscribe from topics.
						</p>
					</div>

					<!-- Activity list -->
					<div v-else class="divide-y divide-border-subtle">
						<div
							v-for="activity in recentActivity"
							:key="activity._id"
							class="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
						>
							<div
								:class="[
									'p-2 rounded-lg bg-bg-surface flex-shrink-0',
									getActivityIcon(activity.activityType).color,
								]"
							>
								<Icon :name="getActivityIcon(activity.activityType).icon" class="w-4 h-4" />
							</div>
							<div class="flex-1 min-w-0">
								<p class="text-sm text-text-primary">
									<NuxtLink
										v-if="activity.contact"
										:to="`/dashboard/audience/contacts/${activity.contact._id}`"
										class="font-medium hover:text-brand transition-colors"
									>
										{{ getContactName(activity.contact) }}
									</NuxtLink>
									<span v-else class="font-medium">Unknown</span>
									<span class="text-text-secondary">
										{{ formatActivityDescription(activity.activityType) }}
									</span>
								</p>
							</div>
							<span class="text-xs text-text-tertiary flex items-center gap-1 flex-shrink-0">
								<Icon name="lucide:clock" class="w-3 h-3" />
								{{ formatCompactRelativeTime(activity.occurredAt) }}
							</span>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>
