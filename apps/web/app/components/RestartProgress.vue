<script setup lang="ts">
import {
	RESTART_PHASE_ORDER,
	RESTART_PHASE_COPY,
	restartProgressPhase,
	restartStepStatus,
	type RestartPhase,
} from '~/utils/restartProgress';

/**
 * Live, phased progress for a config-apply restart, derived from the caller's
 * readiness poll. Both the setup review page and the transport-editor apply flow
 * mount this so the final "restarting…" moment never reads as a silent hang.
 *
 * The caller owns the poll and passes its state down; this component only
 * renders it. When the restart drags past its expected window (`timeout`) the
 * `#timeout` slot appears for call-site-specific recovery copy and actions
 * (e.g. "restart your docker compose stack" vs. "continue now").
 */
const props = defineProps<{
	/** Readiness probes elapsed since apply (each ~2s). */
	pollCount: number;
	/** Whether the readiness probe has cleared — the app is back. */
	ready: boolean;
}>();

const phase = computed<RestartPhase>(() =>
	restartProgressPhase({ pollCount: props.pollCount, ready: props.ready })
);

const steps = computed(() =>
	RESTART_PHASE_ORDER.map((step) => ({
		id: step,
		copy: RESTART_PHASE_COPY[step],
		status: restartStepStatus(step, phase.value),
	}))
);
</script>

<template>
	<div
		class="rounded-lg border border-border-subtle bg-bg-elevated p-4"
		role="status"
		aria-live="polite"
	>
		<ul class="space-y-3">
			<li
				v-for="step in steps"
				:key="step.id"
				class="flex items-start gap-3"
				:aria-current="step.status === 'active' ? 'step' : undefined"
			>
				<span class="mt-0.5 flex size-5 shrink-0 items-center justify-center">
					<Icon
						v-if="step.status === 'complete'"
						name="lucide:check"
						class="size-5 text-success"
						aria-hidden="true"
					/>
					<UiSpinner v-else-if="step.status === 'active'" size="xs" />
					<span v-else class="size-2 rounded-full bg-border-default" aria-hidden="true" />
				</span>
				<span class="min-w-0">
					<span
						class="block text-sm font-medium"
						:class="step.status === 'pending' ? 'text-text-tertiary' : 'text-text-primary'"
					>
						{{ step.copy.label }}
					</span>
					<span v-if="step.status === 'active'" class="block text-sm text-text-secondary">
						{{ step.copy.detail }}
					</span>
				</span>
			</li>
		</ul>

		<div
			v-if="phase === 'timeout'"
			class="mt-4 border-t border-border-subtle pt-4 text-sm text-text-secondary"
		>
			<slot name="timeout" />
		</div>
	</div>
</template>
