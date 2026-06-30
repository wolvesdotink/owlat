<script setup lang="ts">
import { api } from '@owlat/api';

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

// Maps the backend icon tag to a lucide glyph for display.
const iconForActivity: Record<ActivityIcon, string> = {
	email: 'lucide:mail',
	contact: 'lucide:user',
	campaign: 'lucide:megaphone',
	settings: 'lucide:settings',
	automation: 'lucide:workflow',
	list: 'lucide:list',
};

function getIcon(item: ActivityItem): string {
	return iconForActivity[item.icon] ?? 'lucide:activity';
}
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center gap-2.5 mb-4">
				<UiIconBox icon="lucide:activity" size="sm" variant="brand" />
				<h3 class="text-sm font-semibold text-text-primary">Recent Activity</h3>
			</div>

			<div v-if="isLoading" class="flex items-center justify-center py-6">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>

			<div v-else-if="activityList.length === 0" class="py-4 text-center">
				<p class="text-sm text-text-tertiary">No recent activity yet</p>
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
						<Icon :name="getIcon(item)" class="w-3.5 h-3.5" />
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
