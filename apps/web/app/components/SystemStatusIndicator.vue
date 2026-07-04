<script setup lang="ts">
import { api } from '@owlat/api';

// Get system health stats
const { data: healthStats, isLoading } = useOrganizationQuery(api.systemHealth.getHealthStats);

// Dropdown state
const isExpanded = ref(false);
const dropdownRef = ref<HTMLElement | null>(null);

// Close dropdown when clicking outside
useClickOutside(dropdownRef, () => {
	isExpanded.value = false;
});

// Status icon and color mappings
const statusConfig = computed(() => {
	if (!healthStats.value) {
		return {
			icon: 'lucide:activity',
			color: 'text-text-tertiary',
			bgColor: 'bg-bg-surface',
			label: 'Checking...',
		};
	}

	switch (healthStats.value.status) {
		case 'operational':
			return {
				icon: 'lucide:check-circle-2',
				color: 'text-success',
				bgColor: 'bg-success-subtle',
				label: 'All Systems Operational',
			};
		case 'degraded':
			return {
				icon: 'lucide:alert-triangle',
				color: 'text-warning',
				bgColor: 'bg-warning-subtle',
				label: 'Performance Degraded',
			};
		case 'issue':
			return {
				icon: 'lucide:x-circle',
				color: 'text-error',
				bgColor: 'bg-error-subtle',
				label: 'System Issues Detected',
			};
		default:
			return {
				icon: 'lucide:activity',
				color: 'text-text-tertiary',
				bgColor: 'bg-bg-surface',
				label: 'Unknown',
			};
	}
});

// Format last updated time
const lastUpdated = computed(() => {
	if (!healthStats.value?.updatedAt) return null;
	const date = new Date(healthStats.value.updatedAt);
	return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
});
</script>

<template>
	<div ref="dropdownRef" class="relative">
		<!-- Status Button -->
		<button
			class="flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors hover:bg-bg-surface"
			:class="[healthStats?.status !== 'operational' ? statusConfig.bgColor : '']"
			@click="isExpanded = !isExpanded"
		>
			<Icon :name="statusConfig.icon" class="w-4 h-4" :class="statusConfig.color" />
			<span v-if="!isLoading" class="text-text-secondary hidden sm:inline">
				{{ statusConfig.label }}
			</span>
			<span v-else class="text-text-tertiary hidden sm:inline"> Checking status... </span>
			<Icon
				name="lucide:chevron-up"
				class="w-4 h-4 text-text-tertiary transition-transform"
				:class="{ 'rotate-180': !isExpanded }"
			/>
		</button>

		<!-- Expanded Dropdown -->
		<Transition
			enter-active-class="transition-all duration-(--motion-moderate)"
			enter-from-class="opacity-0 translate-y-2"
			enter-to-class="opacity-100 translate-y-0"
			leave-active-class="transition-all duration-(--motion-moderate-exit)"
			leave-from-class="opacity-100 translate-y-0"
			leave-to-class="opacity-0 translate-y-2"
		>
			<div
				v-if="isExpanded"
				class="absolute bottom-full left-0 mb-2 w-72 bg-bg-elevated border border-border-default rounded-lg shadow-lg overflow-hidden"
			>
				<!-- Header -->
				<div class="px-4 py-3 border-b border-border-subtle">
					<div class="flex items-center gap-2">
						<Icon :name="statusConfig.icon" class="w-5 h-5" :class="statusConfig.color" />
						<span class="font-medium text-text-primary">
							{{ statusConfig.label }}
						</span>
					</div>
					<p v-if="lastUpdated" class="text-xs text-text-tertiary mt-1">
						Last checked: {{ lastUpdated }}
					</p>
				</div>

				<!-- Stats -->
				<div class="p-4 space-y-4">
					<!-- Email Queue Depth -->
					<div class="flex items-center justify-between">
						<div class="flex items-center gap-2">
							<Icon name="lucide:mail" class="w-4 h-4 text-text-tertiary" />
							<span class="text-sm text-text-secondary">Email Queue</span>
						</div>
						<span
							class="text-sm font-medium"
							:class="[
								healthStats?.emailQueueDepth && healthStats.emailQueueDepth > 100
									? 'text-warning'
									: 'text-text-primary',
							]"
						>
							{{ healthStats?.emailQueueDepth ?? 0 }} queued
						</span>
					</div>

					<!-- Delivery Success Rate -->
					<div class="flex items-center justify-between">
						<div class="flex items-center gap-2">
							<Icon name="lucide:activity" class="w-4 h-4 text-text-tertiary" />
							<span class="text-sm text-text-secondary">Delivery Rate (24h)</span>
						</div>
						<span
							class="text-sm font-medium"
							:class="[
								healthStats?.recentDeliveryRate != null
									? healthStats.recentDeliveryRate >= 95
										? 'text-success'
										: healthStats.recentDeliveryRate >= 90
											? 'text-warning'
											: 'text-error'
									: 'text-text-tertiary',
							]"
						>
							{{
								healthStats?.recentDeliveryRate != null
									? `${healthStats.recentDeliveryRate}%`
									: 'No data'
							}}
						</span>
					</div>

					<!-- Recent Stats Summary -->
					<div v-if="healthStats?.stats" class="pt-3 border-t border-border-subtle">
						<p class="text-xs text-text-tertiary mb-2">Last 24 hours</p>
						<div class="grid grid-cols-3 gap-2 text-center">
							<div>
								<p class="text-lg font-semibold text-text-primary">
									{{ healthStats.stats.recentSent }}
								</p>
								<p class="text-xs text-text-tertiary">Sent</p>
							</div>
							<div>
								<p class="text-lg font-semibold text-success">
									{{ healthStats.stats.recentDelivered }}
								</p>
								<p class="text-xs text-text-tertiary">Delivered</p>
							</div>
							<div>
								<p class="text-lg font-semibold text-error">
									{{ healthStats.stats.recentBounced }}
								</p>
								<p class="text-xs text-text-tertiary">Bounced</p>
							</div>
						</div>
					</div>

					<!-- Issues List -->
					<div
						v-if="healthStats?.issues && healthStats.issues.length > 0"
						class="pt-3 border-t border-border-subtle"
					>
						<p class="text-xs text-text-tertiary mb-2">Current Issues</p>
						<ul class="space-y-1">
							<li
								v-for="(issue, index) in healthStats.issues"
								:key="index"
								class="flex items-start gap-2"
							>
								<Icon name="lucide:alert-triangle" class="w-3 h-3 text-warning mt-0.5 shrink-0" />
								<span class="text-xs text-text-secondary">{{ issue }}</span>
							</li>
						</ul>
					</div>
				</div>

				<!-- Footer with link to detailed status -->
				<div
					v-if="healthStats?.status !== 'operational'"
					class="px-4 py-3 border-t border-border-subtle bg-bg-surface"
				>
					<NuxtLink
						to="/dashboard/settings?tab=api"
						class="flex items-center justify-center gap-1 text-sm text-brand hover:text-brand-hover transition-colors"
						@click="isExpanded = false"
					>
						View API & Webhook Settings
						<Icon name="lucide:external-link" class="w-3 h-3" />
					</NuxtLink>
				</div>
			</div>
		</Transition>
	</div>
</template>
