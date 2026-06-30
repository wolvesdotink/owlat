<script setup lang="ts">
import { api } from '@owlat/api';

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	// Mirror the nav gate: only reachable when ai.agent is enabled.
	requiresFeature: 'ai.agent',
});

useHead({ title: 'Agent Health — Owlat' });

// Dashboard metrics query
const { data: metrics, isLoading: metricsLoading } = useConvexQuery(
	api.agentHealth.getDashboardMetrics,
	() => ({}),
);

// Metric history for charts
const { data: latencyHistory } = useConvexQuery(
	api.agentHealth.getMetricHistory,
	() => ({ metricType: 'processing_latency' as const, hoursBack: 24 }),
);

const { data: errorHistory } = useConvexQuery(
	api.agentHealth.getMetricHistory,
	() => ({ metricType: 'error_rate' as const, hoursBack: 24 }),
);

const { data: queueHistory } = useConvexQuery(
	api.agentHealth.getMetricHistory,
	() => ({ metricType: 'queue_depth' as const, hoursBack: 24 }),
);

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
		{ type: 'llm_failure', state: 'closed' as const, threshold: 0.20, currentValue: 0 },
		{ type: 'confidence_degradation', state: 'closed' as const, threshold: 0.30, currentValue: 0 },
		{ type: 'rejection_spike', state: 'closed' as const, threshold: 0.40, currentValue: 0 },
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
		<!-- Back Navigation -->
		<NuxtLink
			to="/dashboard/settings"
			class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors mb-6"
		>
			<Icon name="lucide:arrow-left" class="w-4 h-4" />
			Back to Settings
		</NuxtLink>

		<!-- Header -->
		<div class="flex items-center gap-4 mb-8">
			<UiIconBox icon="lucide:activity" size="xl" variant="brand" rounded="full" />
			<div>
				<h1 class="text-2xl font-semibold text-text-primary">Agent Health & Monitoring</h1>
				<p class="text-text-secondary mt-1">
					Monitor the AI agent pipeline performance, circuit breaker states, and key metrics.
				</p>
			</div>
		</div>

		<!-- Loading State -->
		<div v-if="metricsLoading" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<div class="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin" />
				<p class="text-text-secondary text-sm">Loading health metrics...</p>
			</div>
		</div>

		<template v-else>
			<div class="space-y-8 max-w-5xl">
				<!-- Section 1: Circuit Breaker Status -->
				<section>
					<div class="mb-4">
						<h2 class="text-lg font-medium text-text-primary">Circuit Breakers</h2>
						<p class="text-sm text-text-tertiary mt-1">
							Circuit breakers protect the pipeline by halting operations when failure thresholds are exceeded.
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
							:tripped-at="('trippedAt' in breaker ? breaker.trippedAt : undefined)"
						/>
					</div>
				</section>

				<!-- Section 2: Key Metrics Grid -->
				<section>
					<div class="mb-4">
						<h2 class="text-lg font-medium text-text-primary">Key Metrics</h2>
						<p class="text-sm text-text-tertiary mt-1">
							Current snapshot of agent pipeline performance over the last 5 minutes.
						</p>
					</div>
					<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
						<AgentMetricCard
							label="Queue Depth"
							:value="queueDepth"
							icon="lucide:layers"
							description="Messages waiting to be processed"
						/>
						<AgentMetricCard
							label="Processing Latency"
							:value="processingLatency"
							icon="lucide:timer"
							description="Average time to process a message"
						/>
						<AgentMetricCard
							label="Error Rate"
							:value="errorRate"
							icon="lucide:alert-circle"
							:trend="errorTrend"
							description="Percentage of failed agent actions"
						/>
						<AgentMetricCard
							label="Auto-Approve Ratio"
							:value="autoApproveRatio"
							icon="lucide:check-circle"
							description="Actions auto-approved vs. total"
						/>
						<AgentMetricCard
							label="LLM Cost"
							:value="llmCost"
							icon="lucide:coins"
							description="Estimated cost for the current window"
						/>
						<AgentMetricCard
							label="Processing"
							:value="metrics?.processingCount ?? 0"
							icon="lucide:loader"
							description="Messages currently being classified"
						/>
					</div>
				</section>

				<!-- Section 3: Metric History -->
				<section>
					<div class="mb-4">
						<h2 class="text-lg font-medium text-text-primary">Metric History</h2>
						<p class="text-sm text-text-tertiary mt-1">
							Trends over the last 24 hours.
						</p>
					</div>
					<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
						<UiCard>
							<AgentMetricChart
								:data="latencyChartData"
								label="Processing Latency (ms)"
								color="var(--color-brand)"
							/>
						</UiCard>
						<UiCard>
							<AgentMetricChart
								:data="errorChartData"
								label="Error Rate"
								color="var(--color-error)"
							/>
						</UiCard>
						<UiCard class="lg:col-span-2">
							<AgentMetricChart
								:data="queueChartData"
								label="Queue Depth"
								color="var(--color-warning)"
							/>
						</UiCard>
					</div>
				</section>
			</div>
		</template>
	</div>
</template>
