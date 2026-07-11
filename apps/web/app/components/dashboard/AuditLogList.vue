<script setup lang="ts">
import type { AuditLogEntry } from '../../composables/useAuditLogPresentation';

/**
 * The audit-log row list + "Load More" control. Extracted from
 * `pages/dashboard/settings/audit.vue` so the page stays under the file-size
 * ratchet; the page keeps the fetch wiring, filters and empty states and hands
 * this component the already-filtered rows.
 */
defineProps<{
	logs: AuditLogEntry[];
	hasMore: boolean;
}>();

defineEmits<{ loadMore: [] }>();

// Presentation SSOT (labels/icons/colours) — pulled directly so the list is
// self-contained and the page doesn't have to thread these through as props.
const {
	getResourceIcon,
	getResourceLabel,
	getActionLabel,
	getActionIcon,
	getActionColorClass,
	formatTimestamp,
	formatFullDate,
	parseDetails,
	getUserInitials,
} = useAuditLogPresentation();
</script>

<template>
	<div class="space-y-4">
		<div
			v-for="log in logs"
			:key="log._id"
			class="card p-4 hover:bg-bg-surface/30 transition-colors"
		>
			<div class="flex items-start gap-4">
				<!-- User Avatar -->
				<div class="flex-shrink-0">
					<div
						class="w-10 h-10 rounded-full bg-bg-surface flex items-center justify-center text-sm font-medium text-text-secondary"
					>
						{{ getUserInitials(log.userProfile?.name, log.userProfile?.email) }}
					</div>
				</div>

				<!-- Content -->
				<div class="flex-1 min-w-0">
					<div class="flex items-center flex-wrap gap-2 mb-1">
						<!-- User Name -->
						<span class="font-medium text-text-primary">
							{{ log.userProfile?.name ?? log.userProfile?.email ?? 'Unknown User' }}
						</span>

						<!-- Action Badge -->
						<span
							:class="[
								'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
								getActionColorClass(log.action),
							]"
						>
							<Icon :name="getActionIcon(log.action)" class="w-3 h-3" />
							{{ getActionLabel(log.action) }}
						</span>

						<!-- Resource Badge -->
						<span
							class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-bg-surface text-text-secondary"
						>
							<Icon :name="getResourceIcon(log.resource)" class="w-3 h-3" />
							{{ getResourceLabel(log.resource) }}
						</span>
					</div>

					<!-- Details -->
					<div v-if="log.details" class="text-sm text-text-secondary mt-1">
						<template v-if="parseDetails(log.details)['name']">
							<span class="font-medium">"{{ parseDetails(log.details)['name'] }}"</span>
						</template>
						<template v-else-if="parseDetails(log.details)['email']">
							<span class="font-medium">{{ parseDetails(log.details)['email'] }}</span>
						</template>
						<template v-else-if="parseDetails(log.details)['count']">
							<span class="font-medium">{{ parseDetails(log.details)['count'] }} items</span>
						</template>
					</div>

					<!-- Timestamp -->
					<p class="text-xs text-text-tertiary mt-2" :title="formatFullDate(log.createdAt)">
						{{ formatTimestamp(log.createdAt) }}
					</p>
				</div>

				<!-- Resource Icon -->
				<div class="flex-shrink-0">
					<div class="p-2 rounded-lg bg-bg-surface flex items-center justify-center">
						<Icon :name="getResourceIcon(log.resource)" class="w-4 h-4 text-text-secondary" />
					</div>
				</div>
			</div>
		</div>

		<!-- Load More -->
		<div v-if="hasMore" class="flex justify-center pt-4">
			<button class="btn btn-secondary gap-2" @click="$emit('loadMore')">
				<Icon name="lucide:chevron-down" class="w-4 h-4" />
				Load More
			</button>
		</div>
	</div>
</template>
