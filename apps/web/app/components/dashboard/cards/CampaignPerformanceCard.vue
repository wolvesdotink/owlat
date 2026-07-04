<script setup lang="ts">
import { api } from '@owlat/api';

const { data: stats, isLoading } = useOrganizationQuery(api.analytics.dashboard.getStats);

const openRate = computed(() => stats.value?.openRate ?? 0);
const clickRate = computed(() => stats.value?.clickRate ?? 0);
const emailsSent = computed(() => stats.value?.emailsInLast30Days ?? 0);

function formatRate(rate: number): string {
	return `${rate}%`;
}
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-2.5">
					<UiIconBox icon="lucide:bar-chart-3" size="sm" variant="brand" />
					<h3 class="text-sm font-semibold text-text-primary">Campaign Performance</h3>
				</div>
				<NuxtLink
					to="/dashboard/campaigns"
					class="text-xs font-medium text-brand hover:text-brand/80 transition-colors"
				>
					All campaigns
				</NuxtLink>
			</div>

			<div v-if="isLoading" class="flex items-center justify-center py-6">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>

			<div v-else>
				<div class="flex items-baseline gap-2 mb-4">
					<span class="text-3xl font-bold text-text-primary">{{
						emailsSent.toLocaleString()
					}}</span>
					<span class="text-sm text-text-secondary">emails in 30 days</span>
				</div>

				<div class="space-y-3">
					<div>
						<div class="flex items-center justify-between mb-1">
							<span class="text-xs text-text-secondary">Open Rate</span>
							<span class="text-xs font-semibold text-text-primary">{{
								formatRate(openRate)
							}}</span>
						</div>
						<div class="h-1.5 bg-bg-surface rounded-full overflow-hidden">
							<div
								class="h-full bg-brand rounded-full transition-all duration-(--motion-slow)"
								:style="{ width: `${Math.min(openRate, 100)}%` }"
							/>
						</div>
					</div>
					<div>
						<div class="flex items-center justify-between mb-1">
							<span class="text-xs text-text-secondary">Click Rate</span>
							<span class="text-xs font-semibold text-text-primary">{{
								formatRate(clickRate)
							}}</span>
						</div>
						<div class="h-1.5 bg-bg-surface rounded-full overflow-hidden">
							<div
								class="h-full bg-success rounded-full transition-all duration-(--motion-slow)"
								:style="{ width: `${Math.min(clickRate, 100)}%` }"
							/>
						</div>
					</div>
				</div>
			</div>
		</div>
	</UiCard>
</template>
