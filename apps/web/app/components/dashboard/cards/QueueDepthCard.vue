<script setup lang="ts">
import { api } from '@owlat/api';

const { data: stats, isLoading } = useOrganizationQuery(api.inbox.queries.getInboundStats);

const queueItems = computed(() => {
	if (!stats.value) return [];
	return [
		{ label: 'Received', count: stats.value.received ?? 0, color: 'bg-brand' },
		{ label: 'Processing', count: stats.value.processing ?? 0, color: 'bg-warning' },
		{ label: 'Draft Ready', count: stats.value.draftReady ?? 0, color: 'bg-success' },
		{ label: 'Approved', count: stats.value.approved ?? 0, color: 'bg-brand/60' },
	];
});

const totalInQueue = computed(() => {
	return queueItems.value.reduce((sum, item) => sum + item.count, 0);
});

const maxCount = computed(() => {
	return Math.max(...queueItems.value.map((item) => item.count), 1);
});
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-2.5">
					<UiIconBox icon="lucide:layers" size="sm" variant="brand" />
					<h3 class="text-sm font-semibold text-text-primary">Queue Depth</h3>
				</div>
			</div>

			<div v-if="isLoading" class="flex items-center justify-center py-6">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>

			<div v-else>
				<div class="flex items-baseline gap-2 mb-4">
					<span class="text-3xl font-bold text-text-primary">{{ totalInQueue }}</span>
					<span class="text-sm text-text-secondary">messages in pipeline</span>
				</div>

				<div class="space-y-2.5">
					<div v-for="item in queueItems" :key="item.label">
						<div class="flex items-center justify-between mb-1">
							<span class="text-xs text-text-secondary">{{ item.label }}</span>
							<span class="text-xs font-medium text-text-primary">{{ item.count }}</span>
						</div>
						<div class="h-1.5 bg-bg-surface rounded-full overflow-hidden">
							<div
								class="h-full rounded-full transition-all duration-500"
								:class="item.color"
								:style="{ width: `${(item.count / maxCount) * 100}%` }"
							/>
						</div>
					</div>
				</div>
			</div>
		</div>
	</UiCard>
</template>
