<script setup lang="ts">
type CodeTaskStatus = 'queued' | 'running' | 'testing' | 'review' | 'merged' | 'failed';
type CodeTaskStatusVariant = 'default' | 'success' | 'warning' | 'error' | 'neutral';

const props = defineProps<{
	status: CodeTaskStatus;
}>();

const { t } = useI18n();

/** Variant per status; `pulse` marks the one state that is still moving. */
const STATUS_CONFIG: Record<
	CodeTaskStatus,
	{ labelKey: string; variant: CodeTaskStatusVariant; pulse: boolean }
> = {
	queued: {
		labelKey: 'components.codeTasks.codeTaskStatusBadge.queued',
		variant: 'neutral',
		pulse: false,
	},
	running: {
		labelKey: 'components.codeTasks.codeTaskStatusBadge.running',
		variant: 'default',
		pulse: true,
	},
	testing: {
		labelKey: 'components.codeTasks.codeTaskStatusBadge.testing',
		variant: 'warning',
		pulse: false,
	},
	review: {
		labelKey: 'components.codeTasks.codeTaskStatusBadge.review',
		variant: 'default',
		pulse: false,
	},
	merged: {
		labelKey: 'components.codeTasks.codeTaskStatusBadge.merged',
		variant: 'success',
		pulse: false,
	},
	failed: {
		labelKey: 'components.codeTasks.codeTaskStatusBadge.failed',
		variant: 'error',
		pulse: false,
	},
};

const config = computed(() => STATUS_CONFIG[props.status] ?? STATUS_CONFIG.queued);
</script>

<template>
	<UiBadge :variant="config.variant" size="md" pill>
		<template v-if="config.pulse" #icon>
			<span class="w-1.5 h-1.5 rounded-full bg-current animate-pulse motion-reduce:animate-none" />
		</template>
		{{ t(config.labelKey) }}
	</UiBadge>
</template>
