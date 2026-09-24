<script setup lang="ts">
/**
 * Container health (Settings → System & updates): the services the updater
 * sidecar reports, their state and image tag.
 */
const { t } = useI18n();

// Three outcomes, three states — the card used to have one. A failed fetch reset
// the ref to null, which re-rendered "Loading container status…" forever, and a
// response without a `containers` array fell through to a raw `<pre>` dump that
// printed nothing at all (an empty card with a heading and no explanation).
type ContainerHealthStatus = 'loading' | 'ready' | 'failed';
const containerHealth = ref<{
	containers?: Array<{ service: string; state: string; imageTag?: string }>;
} | null>(null);
const containerHealthStatus = ref<ContainerHealthStatus>('loading');
const containerRows = computed(() =>
	Array.isArray(containerHealth.value?.containers) ? containerHealth.value.containers : []
);
async function fetchContainerHealth() {
	containerHealthStatus.value = 'loading';
	try {
		containerHealth.value = await $fetch<{
			containers?: Array<{ service: string; state: string; imageTag?: string }>;
		}>('/api/internal/updater-health');
		containerHealthStatus.value = 'ready';
	} catch {
		containerHealth.value = null;
		containerHealthStatus.value = 'failed';
	}
}
onMounted(fetchContainerHealth);
</script>

<template>
	<div class="card">
		<div class="flex items-center justify-between mb-4">
			<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider">
				{{ t('dashboard.admin.system.index.containers.title') }}
			</h3>
			<button
				type="button"
				class="text-xs text-text-tertiary hover:text-brand transition-colors"
				@click="fetchContainerHealth"
			>
				{{ t('common.refresh') }}
			</button>
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
								:class="
									c.state?.includes('running')
										? 'bg-success/10 text-success'
										: 'bg-warning/10 text-warning'
								"
							>
								<span
									class="w-1.5 h-1.5 rounded-full"
									:class="c.state?.includes('running') ? 'bg-success' : 'bg-warning'"
								/>
								{{ c.state }}
							</span>
						</td>
						<td class="py-2 text-text-secondary font-mono">{{ c.imageTag || '—' }}</td>
					</tr>
				</tbody>
			</table>
		</div>
	</div>
</template>
