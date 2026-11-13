<script setup lang="ts">
/**
 * Container health (Settings → System & updates): the services the updater
 * sidecar reports, their state and image tag.
 */
const { t, te } = useI18n();

// Three outcomes, three states: a null ref alone cannot tell a failed fetch
// from one still loading (it would show "Loading container status…" forever),
// and a response without a `containers` array must say so rather than leave an
// empty card with a heading and no explanation.
type ContainerHealthStatus = 'loading' | 'ready' | 'failed';
const containerHealth = ref<{
	containers?: Array<{ service: string; state: string; imageTag?: string }>;
} | null>(null);
const containerHealthStatus = ref<ContainerHealthStatus>('loading');
// A Refresh keeps the table it already has and spins the button instead, so
// the card does not collapse to the loading line and grow back.
const refreshing = ref(false);
const containerRows = computed(() =>
	Array.isArray(containerHealth.value?.containers) ? containerHealth.value.containers : []
);
async function fetchContainerHealth() {
	if (containerHealthStatus.value === 'ready') refreshing.value = true;
	else containerHealthStatus.value = 'loading';
	try {
		containerHealth.value = await $fetch<{
			containers?: Array<{ service: string; state: string; imageTag?: string }>;
		}>('/api/internal/updater-health');
		containerHealthStatus.value = 'ready';
	} catch {
		containerHealth.value = null;
		containerHealthStatus.value = 'failed';
	} finally {
		refreshing.value = false;
	}
}

// Docker's container states. A stopped or crash-looping container is an error,
// not the mild warning an unfamiliar state gets.
type StateTone = 'success' | 'warning' | 'error';
function stateTone(state: string | undefined): StateTone {
	if (!state) return 'warning';
	if (state.includes('running')) return 'success';
	if (/exited|dead|restarting/.test(state)) return 'error';
	return 'warning';
}
const TONE_PILL: Record<StateTone, string> = {
	success: 'bg-success/10 text-success',
	warning: 'bg-warning/10 text-warning',
	error: 'bg-error/10 text-error',
};
const TONE_DOT: Record<StateTone, string> = {
	success: 'bg-success',
	warning: 'bg-warning',
	error: 'bg-error',
};
/** The words for a known Docker state; anything else is shown as reported. */
function stateLabel(state: string | undefined): string {
	if (!state) return '—';
	const key = `dashboard.admin.system.index.containers.states.${state}`;
	return te(key) ? t(key) : state;
}
onMounted(fetchContainerHealth);
</script>

<template>
	<div class="card">
		<div class="flex items-center justify-between mb-4">
			<h2 class="font-semibold text-text-primary">
				{{ t('dashboard.admin.system.index.containers.title') }}
			</h2>
			<UiButton
				variant="ghost"
				size="sm"
				:loading="refreshing"
				:disabled="containerHealthStatus === 'loading'"
				@click="fetchContainerHealth"
			>
				{{ t('common.refresh') }}
			</UiButton>
		</div>

		<div v-if="containerHealthStatus === 'loading'" class="text-caption text-text-tertiary">
			{{ t('dashboard.admin.system.index.containers.loading') }}
		</div>

		<!-- The read failed: say so, and point at the Refresh above rather than
		     sitting on the loading line forever. -->
		<div v-else-if="containerHealthStatus === 'failed'" class="text-caption text-error">
			{{ t('dashboard.admin.system.index.containers.error') }}
		</div>

		<!-- Answered, but this deployment reports no containers (no updater
		     sidecar, or a payload without the array). A named state, not a dump. -->
		<div v-else-if="containerRows.length === 0" class="text-caption text-text-tertiary">
			{{ t('dashboard.admin.system.index.containers.empty') }}
		</div>

		<!-- Scroll container: three columns of service names and image tags do
		     not fit a phone, and without this the card just clipped them. The
		     negative margin lets the scroll area bleed to the card's edges. -->
		<div v-else class="-mx-6 px-6 overflow-x-auto">
			<table class="w-full min-w-max text-caption">
				<thead>
					<tr class="border-b border-border-subtle text-text-tertiary">
						<th class="text-left py-2 font-medium">
							{{ t('dashboard.admin.system.index.containers.service') }}
						</th>
						<th class="text-left py-2 font-medium">
							{{ t('dashboard.admin.system.index.containers.state') }}
						</th>
						<th class="text-left py-2 font-medium">
							{{ t('dashboard.admin.system.index.containers.imageTag') }}
						</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="c in containerRows"
						:key="c.service"
						class="border-b border-border-subtle last:border-b-0"
					>
						<td class="py-2 text-text-primary font-medium">{{ c.service }}</td>
						<td class="py-2">
							<span
								class="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full"
								:class="TONE_PILL[stateTone(c.state)]"
							>
								<span
									class="w-1.5 h-1.5 rounded-full"
									:class="TONE_DOT[stateTone(c.state)]"
									aria-hidden="true"
								/>
								{{ stateLabel(c.state) }}
							</span>
						</td>
						<td class="py-2 text-text-secondary font-mono">{{ c.imageTag || '—' }}</td>
					</tr>
				</tbody>
			</table>
		</div>
	</div>
</template>
