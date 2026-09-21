<script setup lang="ts">
/**
 * Shown during an in-flight update. Displays the 4 known steps and
 * polls /api/internal/updater-health every 5 s to detect completion
 * (new version showing on the web container).
 *
 * Emits 'complete' once the target version is seen in updater health,
 * 'failed' if the poller times out after 5 minutes.
 */
interface Step {
	step: string;
	/** The sidecar's own verdict for this step: did its docker command exit 0? */
	ok?: boolean;
	stdout?: string;
	stderr?: string;
}

interface UpdaterContainer {
	service: string;
	state: string;
	imageTag?: string;
}

interface UpdaterHealth {
	status: string;
	timestamp: number;
	version?: string;
	gitSha?: string;
	buildDate?: string;
	containers?: UpdaterContainer[] | string;
}

const { t } = useI18n();

const props = defineProps<{
	targetVersion: string;
	steps?: Step[];
}>();

const emit = defineEmits<{
	complete: [health: UpdaterHealth];
	failed: [error: string];
}>();

// Canonical step list in the updater's EXECUTION order (apps/updater/src/update.ts
// handleUpdate): pull first, then the Convex deploy against the still-running old
// stack, then the compose template is promoted, and only then are containers
// recreated. The list used to be written in the order a reader might expect
// rather than the order that runs, which put the running marker on the wrong row.
// The sidecar's own bookkeeping steps — the Docker API preflight, the staged
// template, the version pin, its self-replacement — are not shown; they are
// instant and say nothing a reader of this list needs. They still count as a
// report: a failure in one of them stops the running marker like any other.
const stepOrder = ['pull', 'convex-deploy', 'write-compose', 'up'];
const stepLabelKeys: Record<string, string> = {
	'write-compose': 'components.system.updateProgress.steps.writeCompose',
	'pull': 'components.system.updateProgress.steps.pull',
	'up': 'components.system.updateProgress.steps.up',
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
 * zero — and it is the only trustworthy signal. This used to read non-empty
 * `stderr` as failure, but docker writes pull/recreate PROGRESS to stderr on
 * SUCCESS, so a perfectly healthy update painted "Pull new container images"
 * and "Recreate containers" red and offered ` web Pulled` as the error.
 *
 * The old reading stays as the fallback for the steps that carry no `ok` (the
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
 * Nothing spins once a step has failed (the updater aborts the run there) or
 * once polling has stopped (completed, or timed out).
 */
const stepStatuses = computed<Record<string, StepStatus>>(() => {
	const reported = reportedStatuses.value;
	const aborted = Object.values(reported).includes('failed');
	let inFlightTaken = aborted || !polling.value;

	const statuses: Record<string, StepStatus> = {};
	for (const step of stepOrder) {
		const status = reported[step];
		if (status) {
			statuses[step] = status;
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
	if (elapsedMs.value >= TIMEOUT_MS) {
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

		// Detect completion: updater reports web container's imageTag matches targetVersion
		const containers = Array.isArray(resp.containers) ? resp.containers : [];
		const web = containers.find((c) => c.service === 'web');
		if (web && web.imageTag === props.targetVersion && web.state?.includes('running')) {
			stopPolling();
			emit('complete', resp);
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
function iconForStatus(s: StepStatus): string {
	switch (s) {
		case 'pending':
			return 'lucide:circle';
		case 'running':
			return 'lucide:loader-2';
		case 'success':
			return 'lucide:check-circle-2';
		case 'failed':
			return 'lucide:x-circle';
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
	const mm = Math.floor(sec / 60).toString().padStart(2, '0');
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
			<li
				v-for="(step, idx) in stepOrder"
				:key="step"
				class="flex items-start gap-3"
			>
				<Icon
					:name="iconForStatus(stepStatuses[step] ?? 'pending')"
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
					<p
						v-if="stepStatuses[step] === 'failed'"
						class="text-[0.75rem] text-error mt-1"
					>
						{{ props.steps?.find((s) => s.step === step)?.stderr ?? t('components.system.updateProgress.stepFailed') }}
					</p>
				</div>
			</li>
		</ol>

		<div
			v-if="polling"
			class="mt-4 pt-4 border-t border-border-subtle flex items-start gap-2 text-[0.75rem] text-text-tertiary"
			role="status"
		>
			<Icon
				name="lucide:loader-2"
				class="w-3.5 h-3.5 shrink-0 mt-px animate-spin motion-reduce:animate-none"
				aria-hidden="true"
			/>
			<span>{{ t('components.system.updateProgress.restartNotice') }}</span>
		</div>
	</div>
</template>
