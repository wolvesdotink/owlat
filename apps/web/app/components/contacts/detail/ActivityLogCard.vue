<script setup lang="ts">
import type { useActivityTimeline } from '~/composables/useActivityTimeline';
import { ClockIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

// The activity log under the Timeline tab's messages (admins only). The page
// owns the timeline, so its subscription gate and the pages already loaded
// outlive a switch to another tab.
const props = defineProps<{
	timeline: ReturnType<typeof useActivityTimeline>;
}>();

// The page's one timeline instance: its refs and helpers never change identity.
const {
	accumulatedActivities,
	activitiesLoading,
	hasMoreActivities,
	isLoadingMoreActivities,
	loadMoreActivities,
	getActivityIcon,
	getActivityLabel,
	getActivityColor,
	getActivityDescription,
	formatActivityTime,
} = props.timeline;

const { t } = useI18n();
</script>

<template>
	<div class="card">
		<h2 class="text-lg font-medium text-text-primary mb-4">
			{{ t('dashboard.audience.contacts.detail.activity.title') }}
		</h2>

		<!-- Loading State -->
		<div
			v-if="activitiesLoading && accumulatedActivities.length === 0"
			class="flex items-center justify-center py-8"
		>
			<div class="flex flex-col items-center gap-3">
				<UiSpinner size="md" />
				<p class="text-text-tertiary text-sm">
					{{ t('dashboard.audience.contacts.detail.activity.loading') }}
				</p>
			</div>
		</div>

		<!-- Empty State -->
		<div
			v-else-if="accumulatedActivities.length === 0"
			class="flex flex-col items-center justify-center py-8 text-center"
		>
			<UiIconBox :icon="ClockIcon" size="lg" variant="surface" rounded="full" class="mb-3" />
			<p class="text-text-secondary text-sm">
				{{ t('dashboard.audience.contacts.detail.activity.emptyTitle') }}
			</p>
			<p class="text-text-tertiary text-sm mt-1">
				{{ t('dashboard.audience.contacts.detail.activity.emptyBody') }}
			</p>
		</div>

		<!-- Activity List -->
		<div v-else class="space-y-1">
			<div v-for="(activity, index) in accumulatedActivities" :key="activity._id" class="relative">
				<!-- Timeline connector line -->
				<div
					v-if="index < accumulatedActivities.length - 1"
					class="absolute left-5 top-10 bottom-0 w-px bg-border-subtle"
				/>

				<!-- Activity item -->
				<div class="flex items-start gap-4 py-3">
					<!-- Icon -->
					<div
						class="flex-shrink-0 w-10 h-10 rounded-full bg-bg-surface flex items-center justify-center"
						:class="getActivityColor(activity.activityType)"
					>
						<component :is="getActivityIcon(activity.activityType)" class="w-5 h-5" />
					</div>

					<!-- Content -->
					<div class="flex-1 min-w-0">
						<p class="text-text-primary text-sm font-medium">
							{{ getActivityLabel(activity.activityType) }}
						</p>
						<p
							v-if="getActivityDescription(activity.activityType, activity.metadata)"
							class="text-text-secondary text-sm mt-0.5 truncate"
						>
							{{ getActivityDescription(activity.activityType, activity.metadata) }}
						</p>
						<p class="text-text-tertiary text-xs mt-1">
							{{ formatActivityTime(activity.occurredAt) }}
						</p>
					</div>
				</div>
			</div>

			<!-- Load More Button -->
			<div v-if="hasMoreActivities" class="pt-4 text-center">
				<UiButton
					variant="secondary"
					size="sm"
					:disabled="isLoadingMoreActivities"
					@click="loadMoreActivities"
				>
					<SpinnerIcon v-if="isLoadingMoreActivities" class="w-4 h-4 mr-2" />
					{{
						isLoadingMoreActivities
							? t('common.loading')
							: t('dashboard.audience.contacts.detail.activity.loadMore')
					}}
				</UiButton>
			</div>
		</div>
	</div>
</template>
