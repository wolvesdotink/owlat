<script setup lang="ts">
import { api } from '@owlat/api';

const { data: stats, isLoading } = useOrganizationQuery(api.inbox.queries.getInboundStats);

const pendingCount = computed(() => stats.value?.draftReady ?? 0);
const processingCount = computed(() => stats.value?.processing ?? 0);
const openThreads = computed(() => stats.value?.openThreads ?? 0);
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-2.5">
					<UiIconBox icon="lucide:inbox" size="sm" variant="warning" />
					<h3 class="text-sm font-semibold text-text-primary">Review Queue</h3>
				</div>
				<NuxtLink
					to="/dashboard/inbox/review"
					class="text-xs font-medium text-brand hover:text-brand/80 transition-colors"
				>
					View all
				</NuxtLink>
			</div>

			<div v-if="isLoading" class="flex items-center justify-center py-6">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>

			<div v-else>
				<div class="flex items-baseline gap-2 mb-4">
					<span class="text-3xl font-bold text-text-primary">{{ pendingCount }}</span>
					<span class="text-sm text-text-secondary">drafts awaiting review</span>
				</div>

				<div class="grid grid-cols-2 gap-3">
					<div class="rounded-lg bg-bg-surface px-3 py-2">
						<p class="text-xs text-text-tertiary">Processing</p>
						<p class="text-lg font-semibold text-text-primary">{{ processingCount }}</p>
					</div>
					<div class="rounded-lg bg-bg-surface px-3 py-2">
						<p class="text-xs text-text-tertiary">Open Threads</p>
						<p class="text-lg font-semibold text-text-primary">{{ openThreads }}</p>
					</div>
				</div>
			</div>
		</div>
	</UiCard>
</template>
