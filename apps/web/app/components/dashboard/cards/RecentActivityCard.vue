<script setup lang="ts">
import { api } from '@owlat/api';
import {
	ActivityIcon,
	ListUnorderedIcon,
	MailIcon,
	MegaphoneIcon,
	SettingsIcon,
	UserIcon,
	WorkflowIcon,
	type IconComponent,
} from '@coolicons/vue';

const { t } = useI18n();

const { data: activity, isLoading } = useOrganizationQuery(
	api.analytics.dashboard.getRecentActivity,
	{ limit: 8 }
);

// Mirrors the discriminated icon union the backend tags each item with.
type ActivityIcon = 'email' | 'contact' | 'campaign' | 'settings' | 'automation' | 'list';

interface ActivityItem {
	id: string;
	type: string;
	description: string;
	timestamp: number;
	icon: ActivityIcon;
}

const activityList = computed<ActivityItem[]>(() => {
	return (activity.value as ActivityItem[] | null) ?? [];
});

// Maps the backend icon tag to a glyph for display.
const iconForActivity: Record<ActivityIcon, IconComponent> = {
	email: MailIcon,
	contact: UserIcon,
	campaign: MegaphoneIcon,
	settings: SettingsIcon,
	automation: WorkflowIcon,
	list: ListUnorderedIcon,
};

function getIcon(item: ActivityItem): IconComponent {
	return iconForActivity[item.icon] ?? ActivityIcon;
}
</script>

<template>
	<UiCard class="h-full" padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center gap-2.5 mb-4">
				<UiIconBox :icon="ActivityIcon" size="sm" variant="surface" />
				<h3 class="text-sm font-semibold text-text-primary">
					{{ t('components.dashboard.cards.recentActivityCard.title') }}
				</h3>
			</div>

			<DashboardCardSkeleton v-if="isLoading" shape="list" :count="4" />

			<div v-else-if="activityList.length === 0" class="py-4 text-center">
				<p class="text-sm text-text-tertiary">
					{{ t('components.dashboard.cards.recentActivityCard.empty') }}
				</p>
			</div>

			<div v-else class="space-y-1">
				<div
					v-for="item in activityList"
					:key="item.id"
					class="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-bg-surface transition-colors"
				>
					<div
						class="flex items-center justify-center w-7 h-7 rounded-full bg-brand-subtle text-brand shrink-0"
					>
						<component :is="getIcon(item)" class="w-3.5 h-3.5" />
					</div>
					<div class="flex-1 min-w-0">
						<p class="text-sm text-text-primary truncate">
							{{ item.description }}
						</p>
					</div>
					<span class="text-xs text-text-tertiary shrink-0">
						{{ formatCompactRelativeTime(item.timestamp) }}
					</span>
				</div>
			</div>
		</div>
	</UiCard>
</template>
