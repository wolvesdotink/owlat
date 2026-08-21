<script setup lang="ts">
import { api } from '@owlat/api';

/**
 * The audience overview's "Recent activity" panel: the subscriber-facing slice
 * of the contact activity feed (topic changes and contact creation only), with
 * the icon/copy mapping those rows need. Split out of
 * pages/dashboard/audience/index.vue, which keeps the stats, quick actions and
 * the growth/topics/contacts panels.
 */

const { t } = useI18n();

// Activity types for filtering
type ActivityType = 'topic_subscribed' | 'topic_unsubscribed' | 'topic_confirmed' | 'created';
const subscriberActivityTypes: ActivityType[] = [
	'topic_subscribed',
	'topic_unsubscribed',
	'topic_confirmed',
	'created',
];

// Fetch recent activity (topic changes and contact creation only)
const {
	data: recentActivity,
	isLoading: activityLoading,
	error: activityError,
} = useOrganizationQuery(api.contacts.activities.getRecent, {
	limit: 10,
	activityTypes: subscriberActivityTypes,
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
			return t('dashboard.audience.index.activity.descriptions.topicSubscribed');
		case 'topic_unsubscribed':
			return t('dashboard.audience.index.activity.descriptions.topicUnsubscribed');
		case 'topic_confirmed':
			return t('dashboard.audience.index.activity.descriptions.topicConfirmed');
		case 'created':
			return t('dashboard.audience.index.activity.descriptions.created');
		default:
			return activityType;
	}
}

// Get contact display name
function getContactName(
	contact: { email?: string; firstName?: string; lastName?: string } | null
): string {
	if (!contact) return t('common.unknown');
	if (contact.firstName || contact.lastName) {
		return `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim();
	}
	return contact.email ?? t('common.unknown');
}
</script>

<template>
	<div>
		<div class="flex items-center justify-between mb-4">
			<h2 class="text-lg font-semibold text-text-primary flex items-center gap-2">
				<Icon name="lucide:activity" class="w-5 h-5 text-brand" />
				{{ t('dashboard.audience.index.activity.title') }}
			</h2>
		</div>
		<div class="card">
			<UiQueryBoundary
				:loading="activityLoading"
				:error="activityError"
				:error-title="t('dashboard.audience.index.activity.errorTitle')"
				:loading-label="t('dashboard.audience.index.activity.loading')"
			>
				<div
					v-if="!recentActivity || recentActivity.length === 0"
					class="flex flex-col items-center justify-center py-12 text-center"
				>
					<UiIconBox
						icon="lucide:activity"
						size="xl"
						variant="surface"
						rounded="full"
						class="mb-4"
					/>
					<p class="text-text-secondary font-medium">
						{{ t('dashboard.audience.index.activity.emptyTitle') }}
					</p>
					<p class="text-sm text-text-tertiary mt-1 max-w-sm">
						{{ t('dashboard.audience.index.activity.emptyBody') }}
					</p>
				</div>

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
								<span v-else class="font-medium">{{ t('common.unknown') }}</span>
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
			</UiQueryBoundary>
		</div>
	</div>
</template>
