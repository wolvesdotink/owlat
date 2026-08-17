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

// Canonical step list in execution order. Mapped to icons; updater sidecar
// returns these keys verbatim in its /update response.
const stepOrder = ['write-compose', 'pull', 'up', 'convex-deploy'];
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
const stepStatus = ref<Record<string, StepStatus>>({});
for (const s of stepOrder) stepStatus.value[s] = 'pending';

// Update stepStatus from the steps prop (returned by /api/system/update).
// stderr presence means failure; otherwise success.
watch(
	() => props.steps,
	(steps) => {
		if (!steps) return;
		for (const entry of steps) {
			const failed = entry.stderr && entry.stderr.length > 0 && !entry.stderr.toLowerCase().includes('warning');
			stepStatus.value[entry.step] = failed ? 'failed' : 'success';
		}
	},
	{ deep: true, immediate: true },
);

// Poll updater health until target version appears
const polling = ref(true);
const elapsed = ref(0);
const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 5 * 60 * 1000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function pollHealth() {
	if (!polling.value) return;

	elapsed.value += POLL_INTERVAL_MS;
	if (elapsed.value >= TIMEOUT_MS) {
		polling.value = false;
		emit('failed', t('components.system.updateProgress.timedOut'));
		return;
	}

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
			polling.value = false;
			emit('complete', resp);
		}
	} catch {
		// Likely the web container is restarting — harmless. Next tick retries.
	}
}

onMounted(() => {
	pollTimer = setInterval(pollHealth, POLL_INTERVAL_MS);
	// Fire one immediately
	void pollHealth();
});

onBeforeUnmount(() => {
	if (pollTimer) clearInterval(pollTimer);
	polling.value = false;
});

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
			return 'text-brand animate-spin';
		case 'success':
			return 'text-success';
		case 'failed':
			return 'text-error';
	}
}

const totalElapsedDisplay = computed(() => {
	const sec = Math.floor(elapsed.value / 1000);
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
					:name="iconForStatus(stepStatus[step] ?? 'pending')"
					class="w-5 h-5 shrink-0 mt-0.5"
					:class="colorForStatus(stepStatus[step] ?? 'pending')"
				/>
				<div class="flex-1 min-w-0">
					<p class="text-[0.875rem] text-text-primary">
						<span class="text-text-tertiary mr-2">{{ idx + 1 }}.</span>
						{{ stepLabel(step) }}
					</p>
					<p
						v-if="stepStatus[step] === 'failed'"
						class="text-[0.75rem] text-error mt-1"
					>
						{{ props.steps?.find((s) => s.step === step)?.stderr ?? t('components.system.updateProgress.stepFailed') }}
					</p>
				</div>
			</li>
		</ol>

		<p
			v-if="polling"
			class="mt-4 pt-4 border-t border-border-subtle text-[0.75rem] text-text-tertiary"
		>
			{{ t('components.system.updateProgress.restartNotice') }}
		</p>
	</div>
</template>
