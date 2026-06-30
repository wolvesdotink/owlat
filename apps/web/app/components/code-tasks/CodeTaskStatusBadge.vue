<script setup lang="ts">
const props = defineProps<{
	status: 'queued' | 'running' | 'testing' | 'review' | 'merged' | 'failed';
}>();

const statusConfig = computed((): { label: string; classes: string; pulse: boolean } => {
	const configs: Record<string, { label: string; classes: string; pulse: boolean }> = {
		queued: {
			label: 'Queued',
			classes: 'bg-bg-surface text-text-secondary border border-border-subtle',
			pulse: false,
		},
		running: {
			label: 'Running',
			classes: 'bg-brand-subtle text-brand',
			pulse: true,
		},
		testing: {
			label: 'Testing',
			classes: 'bg-warning-subtle text-warning',
			pulse: false,
		},
		review: {
			label: 'Review',
			classes: 'bg-brand-subtle/60 text-brand',
			pulse: false,
		},
		merged: {
			label: 'Merged',
			classes: 'bg-success-subtle text-success',
			pulse: false,
		},
		failed: {
			label: 'Failed',
			classes: 'bg-error-subtle text-error',
			pulse: false,
		},
	};
	return configs[props.status] ?? configs['queued']!;
});
</script>

<template>
	<span
		:class="[
			'inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full',
			statusConfig.classes,
		]"
	>
		<span
			v-if="statusConfig.pulse"
			class="w-1.5 h-1.5 rounded-full bg-current animate-pulse"
		/>
		{{ statusConfig.label }}
	</span>
</template>
