<script setup lang="ts">
import {
	RESTART_STEP_ORDER,
	RESTART_PHASE_COPY,
	restartProgressPhase,
	restartStepStatus,
	type RestartPhase,
} from '~/utils/restartProgress';
import { CheckIcon } from '@coolicons/vue';

/**
 * Live, phased progress for a config-apply restart, derived from the caller's
 * readiness poll. Mounted by the setup review page and built for reuse by the A1
 * transport-editor apply flow, so the final "restarting…" moment never reads as
 * a silent hang.
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

// `RESTART_PHASE_COPY` is a pure module-scope registry, so its `label`/`detail`
// fields carry message keys rather than sentences; they are resolved here.
const { t } = useI18n();

const phase = computed<RestartPhase>(() =>
	restartProgressPhase({ pollCount: props.pollCount, ready: props.ready })
);

const steps = computed(() =>
	RESTART_STEP_ORDER.map((step) => {
		const status = restartStepStatus(step, phase.value);
		// While timed out, the active row is honest about the wait rather than
		// reassuring "almost there" — its own copy would contradict the recovery
		// notice below it.
		const detail =
			status === 'active' && phase.value === 'timeout'
				? RESTART_PHASE_COPY.timeout.detail
				: RESTART_PHASE_COPY[step].detail;
		return {
			id: step,
			label: RESTART_PHASE_COPY[step].label,
			detail,
			status,
		};
	})
);

// What the live region says: the active step only. The list itself stays out of
// the region, so a poll that moves a step does not re-read every row, and the
// recovery buttons in the timeout slot are not announced as text.
const activeAnnouncement = computed(() => {
	const active = steps.value.find((step) => step.status === 'active');
	return active ? `${t(active.label)}. ${t(active.detail)}` : '';
});
</script>

<template>
	<div class="rounded-lg border border-border-subtle bg-bg-elevated p-4">
		<span class="sr-only" role="status" aria-live="polite">{{ activeAnnouncement }}</span>
		<ul class="space-y-3">
			<li
				v-for="step in steps"
				:key="step.id"
				class="flex items-start gap-3"
				:aria-current="step.status === 'active' ? 'step' : undefined"
			>
				<span class="mt-0.5 flex size-5 shrink-0 items-center justify-center">
					<CheckIcon
						v-if="step.status === 'complete'"
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
						{{ t(step.label) }}
					</span>
					<span v-if="step.status === 'active'" class="block text-sm text-text-secondary">
						{{ t(step.detail) }}
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
