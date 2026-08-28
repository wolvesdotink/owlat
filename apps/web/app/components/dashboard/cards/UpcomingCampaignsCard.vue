<script setup lang="ts">
import { api } from '@owlat/api';

const { t, locale } = useI18n();

const { data: campaignsPage, isLoading } = useOrganizationQuery(
	api.campaigns.campaigns.list,
	{ status: 'scheduled', paginationOpts: { cursor: null, numItems: 5 } }
);

interface Campaign {
	_id: string;
	name: string;
	subject?: string;
	scheduledAt?: number;
	updatedAt: number;
}

const campaigns = computed<Campaign[]>(() => {
	// Typed PaginationResult — no cast needed; a backend projection change now
	// fails typecheck instead of silently reading undefined.
	return campaignsPage.value?.page ?? [];
});

function formatScheduledDate(timestamp?: number): string {
	if (!timestamp) return t('components.dashboard.cards.upcomingCampaignsCard.schedule.notScheduled');
	const date = new Date(timestamp);
	const now = new Date();
	const diffMs = timestamp - now.getTime();
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffHours / 24);

	if (diffDays < 0) return t('components.dashboard.cards.upcomingCampaignsCard.schedule.overdue');
	if (diffDays === 0) {
		if (diffHours <= 0) {
			return t('components.dashboard.cards.upcomingCampaignsCard.schedule.sendingSoon');
		}
		return t('components.dashboard.cards.upcomingCampaignsCard.schedule.inHours', {
			hours: diffHours,
		});
	}
	if (diffDays === 1) return t('components.dashboard.cards.upcomingCampaignsCard.schedule.tomorrow');
	if (diffDays < 7) {
		return t('components.dashboard.cards.upcomingCampaignsCard.schedule.inDays', {
			days: diffDays,
		});
	}
	return new Intl.DateTimeFormat(locale.value, { month: 'short', day: 'numeric' }).format(date);
}

function getTimeUrgency(timestamp?: number): 'default' | 'warning' | 'error' | 'neutral' {
	if (!timestamp) return 'neutral';
	const diffMs = timestamp - Date.now();
	const diffHours = diffMs / 3600000;
	if (diffHours < 0) return 'error';
	if (diffHours < 24) return 'warning';
	return 'default';
}
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-2.5">
					<UiIconBox icon="lucide:calendar-clock" size="sm" variant="brand" />
					<h3 class="text-sm font-semibold text-text-primary">
						{{ t('components.dashboard.cards.upcomingCampaignsCard.title') }}
					</h3>
				</div>
				<NuxtLink
					to="/dashboard/campaigns"
					class="text-xs font-medium text-brand hover:text-brand/80 transition-colors"
				>
					{{ t('components.dashboard.cards.upcomingCampaignsCard.allCampaigns') }}
				</NuxtLink>
			</div>

			<div v-if="isLoading" class="flex items-center justify-center py-6">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin motion-reduce:animate-none text-text-tertiary" />
			</div>

			<div v-else-if="campaigns.length === 0" class="py-4 text-center">
				<Icon name="lucide:calendar" class="w-6 h-6 text-text-tertiary mx-auto mb-2" />
				<p class="text-sm text-text-tertiary">
					{{ t('components.dashboard.cards.upcomingCampaignsCard.empty') }}
				</p>
			</div>

			<div v-else class="space-y-2">
				<div
					v-for="campaign in campaigns"
					:key="campaign._id"
					class="flex items-center justify-between rounded-lg bg-bg-surface px-3 py-2.5"
				>
					<div class="min-w-0 flex-1">
						<p class="text-sm font-medium text-text-primary truncate">{{ campaign.name }}</p>
						<p v-if="campaign.subject" class="text-xs text-text-tertiary truncate">
							{{ campaign.subject }}
						</p>
					</div>
					<UiBadge :variant="getTimeUrgency(campaign.scheduledAt)" size="sm" class="shrink-0 ml-2">
						{{ formatScheduledDate(campaign.scheduledAt) }}
					</UiBadge>
				</div>
			</div>
		</div>
	</UiCard>
</template>
