<script setup lang="ts">
import { api } from '@owlat/api';
import { formatDateTime } from '~/utils/formatters';

useHead({ title: 'System & Updates — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', 'platform-admin'],
});

// ── Current + latest version state ───────────────────────────────────────────

const config = useRuntimeConfig();
const currentVersion = computed(() => (config.public.owlatVersion as string) || 'dev');

// Deployment-wide LLM spend, broken down by feature (last 7 days). The data was
// recorded by every priced LLM call but had no UI surface until now.
const { data: llmSpend } = useOrganizationQuery(
	api.analytics.llmUsage.getSpendByFeature,
	() => ({ hoursBack: 168 }),
);

// Per-org dollar-spend budget: remaining daily/monthly headroom + warn state.
// When a ceiling is hit the autonomous path degrades to draft-only and advisory
// AI is paused (analytics/spendBudget.ts). Unset ceilings ⇒ `configured: false`.
const { data: spendBudget } = useOrganizationQuery(
	api.analytics.spendBudget.getBudgetStatusAdmin,
	() => ({}),
);

// Cached latest-release info from Convex (read-only, reactive)
const { data: latestRelease } = useConvexQuery(api.systemUpdates.getLatestRelease, () => ({}));

// Action to force a fresh GitHub poll
const convex = useConvex();
const checking = ref(false);
async function checkNow() {
	if (!convex) {
		notify('error', 'Convex client not available.');
		return;
	}
	checking.value = true;
	try {
		await convex.action(api.systemUpdates.checkForUpdates, { force: true });
		notify('success', 'Update check complete.');
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Unknown error';
		notify('error', `Check failed: ${msg}`);
	} finally {
		checking.value = false;
	}
}

const updateAvailable = computed(() => {
	const latest = latestRelease.value?.latestVersion;
	const current = currentVersion.value;
	if (!latest || current === 'dev' || current === 'unknown') return false;
	return semverGreater(latest, current);
});

function semverGreater(a: string, b: string): boolean {
	const parse = (s: string) => s.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
	const aParts = parse(a);
	const bParts = parse(b);
	const am = aParts[0] ?? 0, ai = aParts[1] ?? 0, ap = aParts[2] ?? 0;
	const bm = bParts[0] ?? 0, bi = bParts[1] ?? 0, bp = bParts[2] ?? 0;
	if (am !== bm) return am > bm;
	if (ai !== bi) return ai > bi;
	return ap > bp;
}

// ── Update history ───────────────────────────────────────────────────────────

const { data: history } = useConvexQuery(api.systemUpdates.listUpdateHistory, () => ({
	limit: 20,
}));

// ── Container health ─────────────────────────────────────────────────────────

const containerHealth = ref<{ containers?: Array<{ service: string; state: string; imageTag?: string }> } | null>(null);
async function fetchContainerHealth() {
	try {
		containerHealth.value = await $fetch<{ containers?: Array<{ service: string; state: string; imageTag?: string }> }>('/api/internal/updater-health');
	} catch {
		containerHealth.value = null;
	}
}
onMounted(fetchContainerHealth);

// ── Update flow ──────────────────────────────────────────────────────────────

type UpdateState = 'idle' | 'confirming' | 'running' | 'success' | 'failed';
const updateState = ref<UpdateState>('idle');
const updateSteps = ref<Array<{ step: string; stdout?: string; stderr?: string }> | null>(null);
const updateError = ref<string>('');
const pendingTargetVersion = ref<string>('');

function startUpdate() {
	const target = latestRelease.value?.latestVersion;
	if (!target) return;
	pendingTargetVersion.value = target;
	updateState.value = 'confirming';
}

async function confirmUpdate() {
	updateState.value = 'running';
	updateError.value = '';
	updateSteps.value = null;

	try {
		const resp = await $fetch<{ steps?: Array<{ step: string; stdout?: string; stderr?: string }> }>(
			'/api/system/update',
			{
				method: 'POST',
				body: { targetVersion: pendingTargetVersion.value },
				retry: 0,
				// Long timeout for pull+up+convex-deploy
				timeout: 10 * 60 * 1000,
			},
		);
		updateSteps.value = resp.steps ?? null;
		// Don't set success yet — wait for UpdateProgress to confirm new version is live.
	} catch (err) {
		updateState.value = 'failed';
		const msg = err instanceof Error ? err.message : 'Unknown error';
		updateError.value = msg;
	}
}

function cancelConfirm() {
	updateState.value = 'idle';
	pendingTargetVersion.value = '';
}

function onUpdateComplete() {
	updateState.value = 'success';
	// Force a full reload to pick up the new web app
	setTimeout(() => {
		window.location.reload();
	}, 2_000);
}

function onUpdateFailed(error: string) {
	updateState.value = 'failed';
	updateError.value = error;
}

// ── Utility ──────────────────────────────────────────────────────────────────
function notify(kind: 'success' | 'error', message: string) {
	// Best-effort toast — the UI package ships useToast
	try {
		const { showToast } = useToast();
		showToast(message, kind);
	} catch {
		// eslint-disable-next-line no-console
		if (kind === 'error') console.error(message);
	}
}

function formatDuration(start?: number, end?: number) {
	if (!start || !end) return '—';
	const sec = Math.floor((end - start) / 1000);
	if (sec < 60) return `${sec}s`;
	return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}
</script>

<template>
	<div class="max-w-[960px] mx-auto p-8 space-y-6">
		<!-- Page header -->
		<div>
			<NuxtLink to="/dashboard/settings" class="text-[0.8125rem] text-text-tertiary hover:text-brand transition-colors">
				← Settings
			</NuxtLink>
			<h1 class="mt-2 text-2xl font-semibold text-text-primary">System &amp; Updates</h1>
			<p class="mt-1 text-text-secondary text-[0.9375rem]">
				Current Owlat version, container health, and in-app update history.
			</p>
		</div>

		<!-- Current version -->
		<SystemVersionCard />

		<!-- Container health -->
		<div class="rounded-xl border border-border-default bg-bg-elevated p-6">
			<div class="flex items-center justify-between mb-4">
				<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider">Container health</h3>
				<button
					type="button"
					class="text-[0.75rem] text-text-tertiary hover:text-brand transition-colors"
					@click="fetchContainerHealth"
				>
					Refresh
				</button>
			</div>

			<div v-if="!containerHealth" class="text-[0.8125rem] text-text-tertiary">
				Loading container status…
			</div>

			<table v-else-if="Array.isArray(containerHealth.containers)" class="w-full text-[0.8125rem]">
				<thead>
					<tr class="border-b border-border-subtle text-text-tertiary">
						<th class="text-left py-2 font-medium">Service</th>
						<th class="text-left py-2 font-medium">State</th>
						<th class="text-left py-2 font-medium">Image tag</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="c in containerHealth.containers"
						:key="c.service"
						class="border-b border-border-subtle last:border-b-0"
					>
						<td class="py-2 text-text-primary font-medium">{{ c.service }}</td>
						<td class="py-2">
							<span
								class="inline-flex items-center gap-1.5 text-[0.75rem] font-medium px-2 py-0.5 rounded-full"
								:class="c.state?.includes('running') ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'"
							>
								<span class="w-1.5 h-1.5 rounded-full" :class="c.state?.includes('running') ? 'bg-success' : 'bg-warning'" />
								{{ c.state }}
							</span>
						</td>
						<td class="py-2 text-text-secondary font-mono">{{ c.imageTag || '—' }}</td>
					</tr>
				</tbody>
			</table>

			<pre v-else class="text-[0.75rem] text-text-tertiary whitespace-pre-wrap break-words">{{ containerHealth.containers }}</pre>
		</div>

		<!-- LLM spend card -->
		<div class="rounded-xl border border-border-default bg-bg-elevated p-6">
			<div class="flex items-baseline justify-between gap-4 flex-wrap mb-4">
				<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider">LLM spend · last 7 days</h3>
				<p class="text-2xl font-semibold text-text-primary">${{ (llmSpend?.totalCostUsd ?? 0).toFixed(2) }}</p>
			</div>
			<div v-if="llmSpend && llmSpend.features.length" class="space-y-2">
				<div
					v-for="f in llmSpend.features"
					:key="f.feature"
					class="flex items-center justify-between text-sm"
				>
					<span class="text-text-secondary">{{ f.feature }}</span>
					<span class="text-text-primary font-medium">
						${{ f.costUsd.toFixed(2) }}
						<span class="text-text-tertiary font-normal">· {{ f.calls }} calls</span>
					</span>
				</div>
			</div>
			<p v-else class="text-text-tertiary text-sm">No LLM usage recorded in the last 7 days.</p>

			<!-- Spend budget: remaining headroom + warn / paused state -->
			<div v-if="spendBudget?.configured" class="mt-4 pt-4 border-t border-border-default space-y-2">
				<div class="flex items-baseline justify-between gap-2 flex-wrap">
					<h4 class="text-xs font-medium text-text-tertiary uppercase tracking-wider">Spend budget</h4>
					<span
						v-if="spendBudget.state !== 'ok'"
						class="text-[0.6875rem] font-medium px-2 py-0.5 rounded-full"
						:class="spendBudget.state === 'exceeded'
							? 'bg-red-500/15 text-red-500'
							: 'bg-amber-500/15 text-amber-500'"
					>
						{{ spendBudget.state === 'exceeded' ? 'Ceiling reached — auto-send paused' : 'Approaching ceiling' }}
					</span>
				</div>
				<div v-if="spendBudget.daily.configured" class="flex items-center justify-between text-sm">
					<span class="text-text-secondary">Daily remaining</span>
					<span class="text-text-primary font-medium">
						${{ spendBudget.daily.remainingUsd.toFixed(2) }}
						<span class="text-text-tertiary font-normal">of ${{ spendBudget.daily.limitUsd.toFixed(2) }}</span>
					</span>
				</div>
				<div v-if="spendBudget.monthly.configured" class="flex items-center justify-between text-sm">
					<span class="text-text-secondary">Monthly remaining</span>
					<span class="text-text-primary font-medium">
						${{ spendBudget.monthly.remainingUsd.toFixed(2) }}
						<span class="text-text-tertiary font-normal">of ${{ spendBudget.monthly.limitUsd.toFixed(2) }}</span>
					</span>
				</div>
				<p v-if="!spendBudget.advisoryAllowed" class="text-text-tertiary text-xs">
					Advisory AI is paused; the remaining budget is reserved for autonomous replies.
				</p>
			</div>
		</div>

		<!-- Update check card -->
		<div class="rounded-xl border border-border-default bg-bg-elevated p-6">
			<div class="flex items-start justify-between gap-4 flex-wrap">
				<div class="min-w-0">
					<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider mb-2">Available updates</h3>

					<template v-if="updateAvailable && latestRelease?.latestVersion">
						<div class="flex items-baseline gap-3 flex-wrap">
							<span class="text-lg font-semibold text-brand">
								v{{ latestRelease.latestVersion }}
							</span>
							<span class="text-[0.8125rem] text-text-tertiary">
								available (current: v{{ currentVersion }})
							</span>
						</div>
						<p class="mt-1 text-[0.8125rem] text-text-tertiary">
							Released {{ formatDateTime(latestRelease.publishedAt) }}
						</p>
					</template>

					<template v-else-if="latestRelease?.latestVersion">
						<div class="flex items-baseline gap-2">
							<Icon name="lucide:check-circle-2" class="w-5 h-5 text-success" />
							<span class="text-text-primary font-medium">You're on the latest version.</span>
						</div>
						<p class="mt-1 text-[0.8125rem] text-text-tertiary">
							Latest: v{{ latestRelease.latestVersion }} · Last checked {{ formatDateTime(latestRelease.checkedAt) }}
						</p>
					</template>

					<template v-else>
						<p class="text-text-primary">Click "Check now" to poll GitHub for the latest release.</p>
					</template>
				</div>

				<div class="flex gap-2 flex-wrap">
					<button
						type="button"
						:disabled="checking"
						class="inline-flex items-center gap-2 px-4 py-2 text-[0.8125rem] font-medium text-text-primary bg-transparent border border-border-default rounded-lg transition-colors hover:border-brand hover:text-brand disabled:opacity-50"
						@click="checkNow"
					>
						<Icon v-if="checking" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
						<Icon v-else name="lucide:refresh-cw" class="w-4 h-4" />
						Check now
					</button>

					<button
						v-if="updateAvailable"
						type="button"
						class="inline-flex items-center gap-2 px-4 py-2 text-[0.8125rem] font-semibold text-text-inverse bg-brand rounded-lg transition-all hover:bg-brand-hover hover:-translate-y-px hover:shadow-brand-hover"
						@click="startUpdate"
					>
						<Icon name="lucide:download" class="w-4 h-4" />
						Update now
					</button>
				</div>
			</div>

			<!-- Release notes -->
			<details
				v-if="updateAvailable && latestRelease?.releaseNotes"
				class="mt-4 pt-4 border-t border-border-subtle"
			>
				<summary class="text-[0.8125rem] font-medium text-text-primary cursor-pointer hover:text-brand">
					Release notes
				</summary>
				<pre class="mt-3 text-[0.8125rem] text-text-secondary whitespace-pre-wrap font-sans leading-relaxed">{{ latestRelease.releaseNotes }}</pre>
			</details>

			<div v-if="latestRelease?.error" class="mt-3 text-[0.75rem] text-warning">
				Last check had an error: {{ latestRelease.error }}
			</div>
		</div>

		<!-- Confirm dialog -->
		<div
			v-if="updateState === 'confirming'"
			class="rounded-xl border border-warning/40 bg-warning/5 p-6"
		>
			<h3 class="text-base font-semibold text-text-primary mb-2">
				Confirm update to v{{ pendingTargetVersion }}
			</h3>
			<p class="text-[0.875rem] text-text-secondary mb-4">
				This will download the pinned compose template, pull new images, redeploy Convex functions, and recreate containers. The web app may restart mid-flight.
				<br><br>
				<strong>Back up before updating.</strong> Data volumes persist across normal updates, but a release with breaking schema changes may migrate or reset data — check the release notes first.
			</p>
			<div class="flex gap-3">
				<button
					type="button"
					class="px-4 py-2 text-[0.8125rem] font-semibold text-text-inverse bg-warning rounded-lg hover:bg-warning/90"
					@click="confirmUpdate"
				>
					Yes, update now
				</button>
				<button
					type="button"
					class="px-4 py-2 text-[0.8125rem] font-medium text-text-primary border border-border-default rounded-lg hover:border-brand"
					@click="cancelConfirm"
				>
					Cancel
				</button>
			</div>
		</div>

		<!-- In-flight progress -->
		<SystemUpdateProgress
			v-if="updateState === 'running'"
			:target-version="pendingTargetVersion"
			:steps="updateSteps ?? undefined"
			@complete="onUpdateComplete"
			@failed="onUpdateFailed"
		/>

		<!-- Success / failure banners -->
		<div v-if="updateState === 'success'" class="rounded-xl border border-success/40 bg-success/5 p-6">
			<div class="flex items-start gap-3">
				<Icon name="lucide:check-circle-2" class="w-6 h-6 text-success shrink-0" />
				<div>
					<h3 class="font-semibold text-text-primary">Update complete.</h3>
					<p class="mt-1 text-[0.875rem] text-text-secondary">
						Now running v{{ pendingTargetVersion }}. Reloading this page…
					</p>
				</div>
			</div>
		</div>

		<div v-if="updateState === 'failed'" class="rounded-xl border border-error/40 bg-error/5 p-6">
			<div class="flex items-start gap-3">
				<Icon name="lucide:x-circle" class="w-6 h-6 text-error shrink-0" />
				<div class="flex-1 min-w-0">
					<h3 class="font-semibold text-text-primary">Update failed</h3>
					<p class="mt-1 text-[0.875rem] text-error break-words">{{ updateError }}</p>
					<p class="mt-3 text-[0.8125rem] text-text-secondary">
						See the
						<a href="https://docs.owlat.app/developer/self-hosting-maintenance#recovering-from-a-failed-update" target="_blank" rel="noopener" class="text-brand underline">recovery guide</a>
						or run <code class="font-mono text-[0.75rem] bg-bg-surface px-1.5 py-0.5 rounded">owlat doctor</code> on the host.
					</p>
				</div>
			</div>
		</div>

		<!-- Update history -->
		<div class="rounded-xl border border-border-default bg-bg-elevated p-6">
			<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider mb-4">Update history</h3>

			<div v-if="!history || history.length === 0" class="text-[0.8125rem] text-text-tertiary">
				No updates applied yet.
			</div>

			<table v-else class="w-full text-[0.8125rem]">
				<thead>
					<tr class="border-b border-border-subtle text-text-tertiary">
						<th class="text-left py-2 font-medium">From → To</th>
						<th class="text-left py-2 font-medium">Started</th>
						<th class="text-left py-2 font-medium">Duration</th>
						<th class="text-left py-2 font-medium">Status</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="row in history"
						:key="row._id"
						class="border-b border-border-subtle last:border-b-0"
					>
						<td class="py-2 font-mono text-text-primary">
							{{ row.versionFrom || '—' }} → {{ row.versionTo || '—' }}
						</td>
						<td class="py-2 text-text-secondary">{{ formatDateTime(row.startedAt) }}</td>
						<td class="py-2 text-text-secondary">{{ formatDuration(row.startedAt, row.finishedAt) }}</td>
						<td class="py-2">
							<span
								class="inline-flex items-center gap-1.5 text-[0.75rem] font-medium px-2 py-0.5 rounded-full"
								:class="{
									'bg-success/10 text-success': row.status === 'success',
									'bg-error/10 text-error': row.status === 'failed',
									'bg-brand/10 text-brand': row.status === 'running',
								}"
							>
								<span
									class="w-1.5 h-1.5 rounded-full"
									:class="{
										'bg-success': row.status === 'success',
										'bg-error': row.status === 'failed',
										'bg-brand animate-pulse': row.status === 'running',
									}"
								/>
								{{ row.status }}
							</span>
						</td>
					</tr>
				</tbody>
			</table>
		</div>
	</div>
</template>
