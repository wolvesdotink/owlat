<script setup lang="ts">
import { api } from '@owlat/api';

const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.audience.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Fetch audience stats
const { data: audienceStats, isLoading: statsLoading } = useOrganizationQuery(
	api.contacts.analytics.getAudienceStats
);

// Fetch subscriber growth (last 30 days)
const {
	data: subscriberGrowth,
	isLoading: growthLoading,
	error: growthError,
} = useOrganizationQuery(api.contacts.analytics.getSubscriberGrowth);

// Fetch top topics
const {
	data: topLists,
	isLoading: listsLoading,
	error: listsError,
} = useOrganizationQuery(api.contacts.analytics.getTopTopics, { limit: 5 });

// Fetch recent contacts
const {
	data: recentContacts,
	isLoading: contactsLoading,
	error: contactsError,
} = useOrganizationQuery(api.contacts.analytics.getRecent, { limit: 5 });

// Stats for display
const stats = computed(() => [
	{
		label: t('dashboard.audience.index.stats.totalContacts'),
		value: audienceStats.value?.totalContacts ?? 0,
		icon: 'lucide:users',
		color: 'brand',
	},
	{
		label: t('dashboard.audience.index.stats.topics'),
		value: audienceStats.value?.topicCount ?? 0,
		icon: 'lucide:list-plus',
		color: 'brand',
	},
	{
		label: t('dashboard.audience.index.stats.segments'),
		value: audienceStats.value?.segmentCount ?? 0,
		icon: 'lucide:filter',
		color: 'brand',
	},
]);

// Quick actions
const quickActions = computed(() => [
	{
		label: t('dashboard.audience.index.quickActions.addContact.label'),
		href: '/dashboard/audience/contacts?action=add',
		icon: 'lucide:user-plus',
		description: t('dashboard.audience.index.quickActions.addContact.description'),
	},
	{
		label: t('dashboard.audience.index.quickActions.createTopic.label'),
		href: '/dashboard/audience/topics?action=create',
		icon: 'lucide:list-plus',
		description: t('dashboard.audience.index.quickActions.createTopic.description'),
	},
	{
		label: t('dashboard.audience.index.quickActions.createSegment.label'),
		href: '/dashboard/audience/segments?action=create',
		icon: 'lucide:filter',
		description: t('dashboard.audience.index.quickActions.createSegment.description'),
	},
]);

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
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<UiPageHeader
			:title="t('dashboard.audience.index.title')"
			:description="t('dashboard.audience.index.subtitle')"
			class="mb-8"
		>
			<template #actions>
				<UiButton to="/dashboard/audience/contacts?action=add" class="gap-2">
					<Icon name="lucide:plus" class="w-4 h-4" />
					{{ t('dashboard.audience.index.addContact') }}
				</UiButton>
			</template>
		</UiPageHeader>

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
								{{ stat.value.toLocaleString(locale) }}
							</p>
							<Icon
								v-if="statsLoading"
								name="lucide:loader-2"
								class="w-4 h-4 animate-spin motion-reduce:animate-none text-text-tertiary"
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
			<h2 class="text-lg font-semibold text-text-primary mb-4">
				{{ t('dashboard.audience.index.quickActionsHeading') }}
			</h2>
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

		<div class="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
			<!-- Subscriber Growth Chart (Last 30 Days) -->
			<div>
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-lg font-semibold text-text-primary flex items-center gap-2">
						<Icon name="lucide:trending-up" class="w-5 h-5 text-brand" />
						{{ t('dashboard.audience.index.growth.title') }}
					</h2>
					<span class="text-sm text-text-secondary">
						{{
							t('dashboard.audience.index.growth.newCount', {
								count: totalNewSubscribers.toLocaleString(locale),
							})
						}}
					</span>
				</div>
				<div class="card">
					<UiQueryBoundary
						:loading="growthLoading"
						:error="growthError"
						:error-title="t('dashboard.audience.index.growth.errorTitle')"
						:loading-label="t('dashboard.audience.index.growth.loading')"
					>
						<UiBars
							:data="growthBars"
							:height="128"
							:label-every="5"
							:format-value="
								(v: number) =>
									t('dashboard.audience.index.growth.barValue', { count: v.toLocaleString(locale) })
							"
							:aria-label="t('dashboard.audience.index.growth.chartLabel')"
						/>
					</UiQueryBoundary>
				</div>
			</div>

			<!-- Top Topics -->
			<div>
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-lg font-semibold text-text-primary flex items-center gap-2">
						<Icon name="lucide:list-plus" class="w-5 h-5 text-brand" />
						{{ t('dashboard.audience.index.topTopics.title') }}
					</h2>
					<NuxtLink
						to="/dashboard/audience/topics"
						class="text-sm text-brand hover:text-brand-hover flex items-center gap-1"
					>
						{{ t('common.viewAll') }}
						<Icon name="lucide:arrow-right" class="w-3 h-3" />
					</NuxtLink>
				</div>
				<div class="card">
					<UiQueryBoundary
						:loading="listsLoading"
						:error="listsError"
						:error-title="t('dashboard.audience.index.topTopics.errorTitle')"
						:loading-label="t('dashboard.audience.index.topTopics.loading')"
					>
						<div
							v-if="!topLists || topLists.length === 0"
							class="flex flex-col items-center justify-center py-12 text-center"
						>
							<UiIconBox
								icon="lucide:list-plus"
								size="xl"
								variant="surface"
								rounded="full"
								class="mb-4"
							/>
							<p class="text-text-secondary font-medium">
								{{ t('dashboard.audience.index.topTopics.emptyTitle') }}
							</p>
							<p class="text-sm text-text-tertiary mt-1 max-w-sm">
								{{ t('dashboard.audience.index.topTopics.emptyBody') }}
							</p>
							<UiButton to="/dashboard/audience/topics?action=create" class="mt-6 gap-2">
								<Icon name="lucide:plus" class="w-4 h-4" />
								{{ t('dashboard.audience.index.topTopics.createTopic') }}
							</UiButton>
						</div>

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
										{{
											t('dashboard.audience.index.topTopics.contactCount', {
												count: list.contactCount.toLocaleString(locale),
											})
										}}
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
					</UiQueryBoundary>
				</div>
			</div>
		</div>

		<div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
			<!-- Recent Contacts -->
			<div>
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-lg font-semibold text-text-primary flex items-center gap-2">
						<Icon name="lucide:user-plus" class="w-5 h-5 text-brand" />
						{{ t('dashboard.audience.index.recentContacts.title') }}
					</h2>
					<NuxtLink
						to="/dashboard/audience/contacts"
						class="text-sm text-brand hover:text-brand-hover flex items-center gap-1"
					>
						{{ t('common.viewAll') }}
						<Icon name="lucide:arrow-right" class="w-3 h-3" />
					</NuxtLink>
				</div>
				<div class="card">
					<UiQueryBoundary
						:loading="contactsLoading"
						:error="contactsError"
						:error-title="t('dashboard.audience.index.recentContacts.errorTitle')"
						:loading-label="t('dashboard.audience.index.recentContacts.loading')"
					>
						<div
							v-if="!recentContacts || recentContacts.length === 0"
							class="flex flex-col items-center justify-center py-12 text-center"
						>
							<UiIconBox
								icon="lucide:users"
								size="xl"
								variant="surface"
								rounded="full"
								class="mb-4"
							/>
							<p class="text-text-secondary font-medium">
								{{ t('dashboard.audience.index.recentContacts.emptyTitle') }}
							</p>
							<p class="text-sm text-text-tertiary mt-1 max-w-sm">
								{{ t('dashboard.audience.index.recentContacts.emptyBody') }}
							</p>
							<UiButton to="/dashboard/audience/contacts?action=add" class="mt-6 gap-2">
								<Icon name="lucide:plus" class="w-4 h-4" />
								{{ t('dashboard.audience.index.addContact') }}
							</UiButton>
						</div>

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
					</UiQueryBoundary>
				</div>
			</div>

			<!-- Recent Activity -->
			<AudienceSubscriberActivityCard />
		</div>
	</div>
</template>
