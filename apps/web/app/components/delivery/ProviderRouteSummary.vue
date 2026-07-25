<script setup lang="ts">
interface RouteProvider {
	providerType: string;
	weight?: number;
	isEnabled: boolean;
}

interface RouteSummary {
	strategy: string;
	providers: RouteProvider[];
	ipPool?: string;
	deliverabilityFallback?: {
		isEnabled: boolean;
		relayProviderType: string;
		isWarmupOverflowEnabled: boolean;
	};
}

defineProps<{
	route: RouteSummary;
	strategyLabel: (strategy: string) => string;
	providerLabel: (providerType: string) => string;
}>();
</script>

<template>
	<div class="mt-3 space-y-2">
		<span
			class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-brand/20 text-brand border-brand/30"
		>
			<Icon name="lucide:git-branch" class="w-3 h-3" />
			{{ strategyLabel(route.strategy) }}
		</span>
		<div class="flex flex-wrap items-center gap-2">
			<span
				v-for="(provider, index) in route.providers.filter((entry) => entry.isEnabled)"
				:key="provider.providerType"
				class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium bg-bg-surface text-text-secondary border border-border-subtle"
			>
				<span class="text-text-tertiary">{{ index + 1 }}.</span>
				{{ providerLabel(provider.providerType) }}
				<span v-if="route.strategy === 'workload_split'" class="text-text-tertiary">
					({{ provider.weight ?? 0 }})
				</span>
			</span>
		</div>
		<p v-if="route.ipPool" class="text-xs text-text-tertiary">IP pool: {{ route.ipPool }}</p>
		<p v-if="route.deliverabilityFallback?.isEnabled" class="text-xs text-text-tertiary">
			Automatic relay fallback:
			{{ providerLabel(route.deliverabilityFallback.relayProviderType) }}
		</p>
	</div>
</template>
