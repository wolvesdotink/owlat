<script setup lang="ts">
/**
 * Shown during an in-flight update. Displays the 4 known steps and
 * polls /api/internal/updater-health every 5 s for the updater's verdict on
 * this attempt (see `readRolloutProgress`).
 *
 * Emits 'complete' once the updater reports the rollout healthy (or, from an
 * updater that keeps no record, once the web container runs the target
 * version), 'started' when the release is live but not every service passed
 * the readiness check, and 'failed' on a failed rollout or when the poller
 * times out.
 */
import {
	readRolloutProgress,
	UPDATE_REQUEST_TIMEOUT_MS,
	type RolloutStage,
	type UpdaterHealth,
} from '~/lib/systemUpdate';
import { CircleCheckIcon, CircleCloseIcon, CircleIcon, type IconComponent } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

interface Step {
	step: string;
	/** The sidecar's own verdict for this step: did its docker command exit 0? */
	ok?: boolean;
	stdout?: string;
	stderr?: string;
}

const { t } = useI18n();

const props = defineProps<{
	targetVersion: string;
	steps?: Step[];
	/** This attempt's id, which the updater echoes with its verdict. */
	attempt?: string;
}>();

const emit = defineEmits<{
	complete: [health: UpdaterHealth];
	started: [summary: string];
	failed: [error: string];
}>();

// Canonical step list in the updater's EXECUTION order (apps/updater/src/update.ts
// handleUpdate): pull first, then the Convex deploy against the still-running old
// stack, then the compose template is promoted, and only then are containers
// recreated. The list must follow the order that runs, not the order a reader
// might expect, or the running marker lands on the wrong row.
// The sidecar's own bookkeeping steps — the Docker API preflight, the staged
// template, the version pin, its self-replacement — are not shown; they are
// instant and say nothing a reader of this list needs. They still count as a
// report: a failure in one of them stops the running marker like any other.
const stepOrder = ['pull', 'convex-deploy', 'write-compose', 'up'];
const stepLabelKeys: Record<string, string> = {
	'write-compose': 'components.system.updateProgress.steps.writeCompose',
	pull: 'components.system.updateProgress.steps.pull',
	up: 'components.system.updateProgress.steps.up',
	'convex-deploy': 'components.system.updateProgress.steps.convexDeploy',
};

// An unknown step keeps the old behaviour — its raw key — rather than painting a
// missing message path into the update log.
function stepLabel(step: string): string {
	const key = stepLabelKeys[step];
	return key ? t(key) : step;
}

// Current step status (pending / running / success / failed)
type StepStatus = 'pending' | 'running' | 'success' | 'failed';

/**
 * Read one step's outcome out of the updater's report.
 *
 * `ok` is the sidecar's own verdict — whether that step's docker command exited
 * zero — and it is the only trustworthy signal. Non-empty `stderr` is not a
 * failure: docker writes pull/recreate PROGRESS to stderr on SUCCESS, so
 * reading it that way paints a healthy "Pull new container images" and
 * "Recreate containers" red and offers ` web Pulled` as the error.
 *
 * The stderr reading stays as the fallback for the steps that carry no `ok` (the
 * sidecar's own compose-file writes) and for runs recorded before `ok` was
 * kept: there, output on stderr really is the only evidence there is.
 */
function stepOutcome(entry: Step): StepStatus {
	if (typeof entry.ok === 'boolean') return entry.ok ? 'success' : 'failed';
	const stderr = entry.stderr ?? '';
	const failed = stderr.length > 0 && !stderr.toLowerCase().includes('warning');
	return failed ? 'failed' : 'success';
}

// Poll updater health until target version appears
const polling = ref(true);
// Wall-clock start, not a tally of ticks: a backgrounded tab throttles timers,
// and the elapsed figure has to stay the real one when the operator comes back.
const startedAt = Date.now();
const elapsedMs = ref(0);
const TICK_INTERVAL_MS = 1_000;
const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 5 * 60 * 1000;
// Once the updater reports it is working on this attempt, the wait follows it
// for as long as the update itself may take.
const IN_FLIGHT_TIMEOUT_MS = UPDATE_REQUEST_TIMEOUT_MS;
// Seen the updater working on this attempt; lifts the timeout above.
const updaterWorking = ref(false);
// How far /health says the update has got (see `RolloutStage`).
const stage = ref<RolloutStage>('applying');
// The last stage that moved the update forward. A rollback can start after
// any step, so the rows keep what they showed done before it began.
const forwardStage = ref<Exclude<RolloutStage, 'rolling-back'>>('applying');
// The recreate is done and the updater is checking the stack's health.
const verifying = computed(() => stage.value === 'verifying');
// The release failed and the updater is restoring the snapshot taken before it.
const rollingBack = computed(() => stage.value === 'rolling-back');

/**
 * The displayed steps /health shows are behind the update, though the updater
 * has not answered with its step log yet (it answers once, at the very end).
 * Without this the card kept its spinner on "Pull new container images" while
 * the note under it said the new version was already running.
 */
const STEPS_BEHIND_STAGE: Record<Exclude<RolloutStage, 'rolling-back'>, readonly string[]> = {
	applying: [],
	recreating: ['pull', 'convex-deploy', 'write-compose'],
	verifying: stepOrder,
};
let pollTimer: ReturnType<typeof setInterval> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;

// What the updater has already reported on (every step it returns, displayed or
// not). The /update response arrives in one piece when the whole run is over, so
// this map is empty for the minutes the update actually takes.
const reportedStatuses = computed<Record<string, StepStatus>>(() => {
	const reported: Record<string, StepStatus> = {};
	for (const entry of props.steps ?? []) reported[entry.step] = stepOutcome(entry);
	return reported;
});

/**
 * Status per displayed step. Since the updater reports nothing until it is
 * finished, the first step it has not reported on is the one in flight — that is
 * the row that gets the spinner, so the card shows work happening instead of
 * four inert circles for the length of the update.
 *
 * Nothing spins once a step has failed (the updater aborts the run there),
 * once polling has stopped (completed, or timed out), or while the updater
 * rolls the release back: no step of the update is running then.
 */
const stepStatuses = computed<Record<string, StepStatus>>(() => {
	const reported = reportedStatuses.value;
	const aborted = Object.values(reported).includes('failed');
	let inFlightTaken = aborted || !polling.value || rollingBack.value;
	const behind = STEPS_BEHIND_STAGE[forwardStage.value];

	const statuses: Record<string, StepStatus> = {};
	for (const step of stepOrder) {
		const status = reported[step];
		if (status) {
			statuses[step] = status;
		} else if (behind.includes(step)) {
			statuses[step] = 'success';
		} else if (inFlightTaken) {
			statuses[step] = 'pending';
		} else {
			statuses[step] = 'running';
			inFlightTaken = true;
		}
	}
	return statuses;
});

function stopPolling() {
	polling.value = false;
	if (pollTimer) clearInterval(pollTimer);
	if (tickTimer) clearInterval(tickTimer);
	pollTimer = null;
	tickTimer = null;
}

function tick() {
	if (!polling.value) return;

	elapsedMs.value = Date.now() - startedAt;
	if (elapsedMs.value >= (updaterWorking.value ? IN_FLIGHT_TIMEOUT_MS : TIMEOUT_MS)) {
		stopPolling();
		emit('failed', t('components.system.updateProgress.timedOut'));
	}
}

async function pollHealth() {
	if (!polling.value) return;

	try {
		const resp = await $fetch<UpdaterHealth>('/api/internal/updater-health', {
			method: 'GET',
			retry: 0,
			timeout: 8_000,
		});

		const reading = readRolloutProgress(resp, props.targetVersion, props.attempt);
		if (reading.kind === 'in-flight') {
			updaterWorking.value = true;
			stage.value = reading.stage;
			if (reading.stage !== 'rolling-back') forwardStage.value = reading.stage;
		} else if (reading.kind === 'complete') {
			stopPolling();
			emit('complete', resp);
		} else if (reading.kind === 'started') {
			stopPolling();
			emit('started', reading.summary);
		} else if (reading.kind === 'failed') {
			stopPolling();
			emit('failed', reading.summary || t('components.system.updateProgress.stepFailed'));
		}
	} catch {
		// Likely the web container is restarting — harmless. Next tick retries.
	}
}

onMounted(() => {
	// Two cadences on purpose: the clock reads as a clock (1 s), while the health
	// probe stays at 5 s so a stack mid-restart is not hammered.
	tickTimer = setInterval(tick, TICK_INTERVAL_MS);
	pollTimer = setInterval(pollHealth, POLL_INTERVAL_MS);
	// Fire one immediately
	void pollHealth();
});

onBeforeUnmount(stopPolling);

// UI helpers
function iconForStatus(s: StepStatus): IconComponent {
	switch (s) {
		case 'pending':
			return CircleIcon;
		case 'running':
			return SpinnerIcon;
		case 'success':
			return CircleCheckIcon;
		case 'failed':
			return CircleCloseIcon;
	}
}

function colorForStatus(s: StepStatus): string {
	switch (s) {
		case 'pending':
			return 'text-text-disabled';
		case 'running':
			return 'text-brand animate-spin motion-reduce:animate-none';
		case 'success':
			return 'text-success';
		case 'failed':
			return 'text-error';
	}
}

const totalElapsedDisplay = computed(() => {
	const sec = Math.floor(elapsedMs.value / 1000);
	const mm = Math.floor(sec / 60)
		.toString()
		.padStart(2, '0');
	const ss = (sec % 60).toString().padStart(2, '0');
	return `${mm}:${ss}`;
});
</script>

<template>
	<div class="rounded-xl border border-border-default bg-bg-elevated p-6">
		<div class="flex items-center justify-between mb-4">
			<h3 class="text-base font-semibold text-text-primary">
				{{ t('components.system.updateProgress.heading', { version: targetVersion }) }}
			</h3>
			<span class="text-[0.75rem] text-text-tertiary font-mono">{{ totalElapsedDisplay }}</span>
		</div>

		<ol class="space-y-3">
			<li v-for="(step, idx) in stepOrder" :key="step" class="flex items-start gap-3">
				<component
					:is="iconForStatus(stepStatuses[step] ?? 'pending')"
					class="w-5 h-5 shrink-0 mt-0.5"
					:class="colorForStatus(stepStatuses[step] ?? 'pending')"
					aria-hidden="true"
				/>
				<div class="flex-1 min-w-0">
					<p
						class="text-[0.875rem] text-text-primary"
						:class="stepStatuses[step] === 'running' ? 'font-medium' : ''"
					>
						<span class="text-text-tertiary mr-2">{{ idx + 1 }}.</span>
						{{ stepLabel(step) }}
					</p>
					<p v-if="stepStatuses[step] === 'failed'" class="text-[0.75rem] text-error mt-1">
						{{
							props.steps?.find((s) => s.step === step)?.stderr ??
							t('components.system.updateProgress.stepFailed')
						}}
					</p>
				</div>
			</li>
		</ol>

		<div
			v-if="polling"
			class="mt-4 pt-4 border-t border-border-subtle flex items-start gap-2 text-[0.75rem] text-text-tertiary"
			role="status"
		>
			<SpinnerIcon class="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
			<span>{{
				rollingBack
					? t('components.system.updateProgress.rollingBackNotice')
					: verifying
						? t('components.system.updateProgress.verifyingNotice')
						: t('components.system.updateProgress.restartNotice')
			}}</span>
		</div>
	</div>
</template>
