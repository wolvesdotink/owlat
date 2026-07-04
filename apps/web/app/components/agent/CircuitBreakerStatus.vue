<script setup lang="ts">
interface Props {
	breakerType: string;
	state: 'closed' | 'open' | 'half_open';
	threshold: number;
	currentValue: number;
	trippedAt?: number;
}

const props = defineProps<Props>();

const formattedName = computed(() => {
	const names: Record<string, string> = {
		llm_failure: 'LLM Failure',
		confidence_degradation: 'Confidence Degradation',
		rejection_spike: 'Rejection Spike',
	};
	return (
		names[props.breakerType] ??
		props.breakerType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
	);
});

const stateConfig = computed(() => {
	switch (props.state) {
		case 'closed':
			return { label: 'Healthy', color: 'text-success', bg: 'bg-success', dotBg: 'bg-success' };
		case 'open':
			return { label: 'Tripped', color: 'text-error', bg: 'bg-error', dotBg: 'bg-error' };
		case 'half_open':
			return { label: 'Recovering', color: 'text-warning', bg: 'bg-warning', dotBg: 'bg-warning' };
		default:
			return {
				label: 'Unknown',
				color: 'text-text-tertiary',
				bg: 'bg-bg-surface',
				dotBg: 'bg-bg-surface',
			};
	}
});

const trippedAgo = computed(() => {
	if (!props.trippedAt) return null;
	return formatCompactRelativeTime(props.trippedAt);
});

const thresholdPercent = computed(() => Math.round(props.threshold * 100));
const currentPercent = computed(() => Math.round(props.currentValue * 100));
const progressPercent = computed(() => {
	if (props.threshold === 0) return 0;
	return Math.min(100, (props.currentValue / props.threshold) * 100);
});
</script>

<template>
	<UiCard>
		<div class="flex items-start justify-between mb-4">
			<div>
				<h3 class="text-sm font-medium text-text-primary">{{ formattedName }}</h3>
				<div class="flex items-center gap-2 mt-1">
					<span class="inline-block w-2 h-2 rounded-full" :class="stateConfig.dotBg" />
					<span class="text-xs font-medium" :class="stateConfig.color">
						{{ stateConfig.label }}
					</span>
				</div>
			</div>
			<Icon
				:name="
					state === 'closed'
						? 'lucide:shield-check'
						: state === 'open'
							? 'lucide:shield-off'
							: 'lucide:shield-alert'
				"
				class="w-5 h-5"
				:class="stateConfig.color"
			/>
		</div>

		<div class="space-y-3">
			<div>
				<div class="flex items-center justify-between text-xs text-text-tertiary mb-1">
					<span>Current: {{ currentPercent }}%</span>
					<span>Threshold: {{ thresholdPercent }}%</span>
				</div>
				<div class="w-full h-2 bg-bg-surface rounded-full overflow-hidden">
					<div
						class="h-full rounded-full transition-all duration-(--motion-slow)"
						:class="
							state === 'closed' ? 'bg-success' : state === 'open' ? 'bg-error' : 'bg-warning'
						"
						:style="{ width: `${progressPercent}%` }"
					/>
				</div>
			</div>

			<p v-if="state !== 'closed' && trippedAgo" class="text-xs" :class="stateConfig.color">
				Tripped {{ trippedAgo }}
			</p>
		</div>
	</UiCard>
</template>
