<script setup lang="ts">
import { api } from '@owlat/api';

definePageMeta({
	layout: 'admin',
	middleware: ['auth', 'admin'],
	// Mirror the nav gate: only reachable when ai.agent is enabled.
	requiresFeature: 'ai.agent',
});

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.instance.agentHealth.pageTitle') });

// Dashboard metrics query
const { data: metrics, isLoading: metricsLoading } = useConvexQuery(
	api.agentHealth.getDashboardMetrics,
	() => ({})
);

// Metric history for charts
const { data: latencyHistory } = useConvexQuery(api.agentHealth.getMetricHistory, () => ({
	metricType: 'processing_latency' as const,
	hoursBack: 24,
}));

const { data: errorHistory } = useConvexQuery(api.agentHealth.getMetricHistory, () => ({
	metricType: 'error_rate' as const,
	hoursBack: 24,
}));

const { data: queueHistory } = useConvexQuery(api.agentHealth.getMetricHistory, () => ({
	metricType: 'queue_depth' as const,
	hoursBack: 24,
}));

// Derived display values
const queueDepth = computed(() => metrics.value?.queueDepth ?? 0);
const processingLatency = computed(() => {
	const ms = metrics.value?.processingLatencyMs ?? 0;
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
});
const errorRate = computed(() => {
	const rate = metrics.value?.errorRate ?? 0;
	return `${(rate * 100).toFixed(1)}%`;
});
const autoApproveRatio = computed(() => {
	const ratio = metrics.value?.autoApproveRatio ?? 0;
	return `${(ratio * 100).toFixed(1)}%`;
});
const llmCost = computed(() => {
	const cost = metrics.value?.llmCost ?? 0;
	return `$${cost.toFixed(4)}`;
});

// Circuit breakers with fallback defaults
const circuitBreakers = computed(() => {
	if (metrics.value?.circuitBreakers?.length) {
		return metrics.value.circuitBreakers;
	}
	return [
		{ type: 'llm_failure', state: 'closed' as const, threshold: 0.2, currentValue: 0 },
		{ type: 'confidence_degradation', state: 'closed' as const, threshold: 0.3, currentValue: 0 },
		{ type: 'rejection_spike', state: 'closed' as const, threshold: 0.4, currentValue: 0 },
	];
});

// Transform metric history for charts
function toChartData(history: Array<{ windowStart: number; value: number }> | null | undefined) {
	if (!history?.length) return [];
	return history.map((m) => ({ timestamp: m.windowStart, value: m.value }));
}

const latencyChartData = computed(() => toChartData(latencyHistory.value));
const errorChartData = computed(() => toChartData(errorHistory.value));
const queueChartData = computed(() => toChartData(queueHistory.value));

// Error rate trend
const errorTrend = computed<'up' | 'down' | 'stable'>(() => {
	const data = errorChartData.value;
	if (data.length < 2) return 'stable';
	const recent = data.slice(-3);
	const earlier = data.slice(0, 3);
	const recentAvg = recent.reduce((s, d) => s + d.value, 0) / recent.length;
	const earlierAvg = earlier.reduce((s, d) => s + d.value, 0) / earlier.length;
	if (recentAvg > earlierAvg * 1.1) return 'up';
	if (recentAvg < earlierAvg * 0.9) return 'down';
	return 'stable';
});
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex items-center gap-4 mb-8">
			<UiIconBox icon="lucide:activity" size="xl" variant="brand" rounded="full" />
			<div>
				<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
					{{ t('dashboard.admin.instance.agentHealth.title') }}
				</h1>
				<p class="text-text-secondary mt-1">
					{{ t('dashboard.admin.instance.agentHealth.subtitle') }}
				</p>
			</div>
		</div>

		<!-- Loading State -->
		<div v-if="metricsLoading" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">
					{{ t('dashboard.admin.instance.agentHealth.loading') }}
				</p>
			</div>
		</div>

		<template v-else>
			<div class="space-y-8 max-w-5xl">
				<!-- Section 1: Circuit Breaker Status -->
				<section>
					<div class="mb-4">
						<h2 class="text-lg font-medium text-text-primary">
							{{ t('dashboard.admin.instance.agentHealth.circuitBreakers.title') }}
						</h2>
						<p class="text-sm text-text-tertiary mt-1">
							{{ t('dashboard.admin.instance.agentHealth.circuitBreakers.description') }}
						</p>
					</div>
					<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
						<AgentCircuitBreakerStatus
							v-for="breaker in circuitBreakers"
							:key="breaker.type"
							:breaker-type="breaker.type"
							:state="breaker.state"
							:threshold="breaker.threshold"
							:current-value="breaker.currentValue"
							:tripped-at="'trippedAt' in breaker ? breaker.trippedAt : undefined"
						/>
					</div>
				</section>

				<!-- Section 2: Key Metrics Grid -->
				<section>
					<div class="mb-4">
						<h2 class="text-lg font-medium text-text-primary">
							{{ t('dashboard.admin.instance.agentHealth.keyMetrics.title') }}
						</h2>
						<p class="text-sm text-text-tertiary mt-1">
							{{ t('dashboard.admin.instance.agentHealth.keyMetrics.description') }}
						</p>
					</div>
					<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
						<AgentMetricCard
							:label="t('dashboard.admin.instance.agentHealth.metrics.queueDepth.label')"
							:value="queueDepth"
							icon="lucide:layers"
							:description="t('dashboard.admin.instance.agentHealth.metrics.queueDepth.description')"
						/>
						<AgentMetricCard
							:label="t('dashboard.admin.instance.agentHealth.metrics.latency.label')"
							:value="processingLatency"
							icon="lucide:timer"
							:description="t('dashboard.admin.instance.agentHealth.metrics.latency.description')"
						/>
						<AgentMetricCard
							:label="t('dashboard.admin.instance.agentHealth.metrics.errorRate.label')"
							:value="errorRate"
							icon="lucide:alert-circle"
							:trend="errorTrend"
							:description="t('dashboard.admin.instance.agentHealth.metrics.errorRate.description')"
						/>
						<AgentMetricCard
							:label="t('dashboard.admin.instance.agentHealth.metrics.autoApprove.label')"
							:value="autoApproveRatio"
							icon="lucide:check-circle"
							:description="t('dashboard.admin.instance.agentHealth.metrics.autoApprove.description')"
						/>
						<AgentMetricCard
							:label="t('dashboard.admin.instance.agentHealth.metrics.llmCost.label')"
							:value="llmCost"
							icon="lucide:coins"
							:description="t('dashboard.admin.instance.agentHealth.metrics.llmCost.description')"
						/>
						<AgentMetricCard
							:label="t('dashboard.admin.instance.agentHealth.metrics.processing.label')"
							:value="metrics?.processingCount ?? 0"
							icon="lucide:loader"
							:description="t('dashboard.admin.instance.agentHealth.metrics.processing.description')"
						/>
					</div>
				</section>

				<!-- Section 3: Metric History -->
				<section>
					<div class="mb-4">
						<h2 class="text-lg font-medium text-text-primary">
							{{ t('dashboard.admin.instance.agentHealth.history.title') }}
						</h2>
						<p class="text-sm text-text-tertiary mt-1">
							{{ t('dashboard.admin.instance.agentHealth.history.description') }}
						</p>
					</div>
					<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
						<UiCard>
							<AgentMetricChart
								:data="latencyChartData"
								:label="t('dashboard.admin.instance.agentHealth.charts.latency')"
								color="var(--color-brand)"
							/>
						</UiCard>
						<UiCard>
							<AgentMetricChart
								:data="errorChartData"
								:label="t('dashboard.admin.instance.agentHealth.charts.errorRate')"
								color="var(--color-error)"
							/>
						</UiCard>
						<UiCard class="lg:col-span-2">
							<AgentMetricChart
								:data="queueChartData"
								:label="t('dashboard.admin.instance.agentHealth.charts.queueDepth')"
								color="var(--color-warning)"
							/>
						</UiCard>
					</div>
				</section>
			</div>
		</template>
	</div>
</template>
