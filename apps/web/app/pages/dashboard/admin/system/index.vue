<script setup lang="ts">
import { api } from '@owlat/api';
import { semverCompare } from '@owlat/shared/semver';
import { formatDateTime } from '~/utils/formatters';

const { t } = useI18n();
const { showToast } = useToast();

useHead({ title: () => t('dashboard.admin.system.index.pageTitle') });

definePageMeta({
	layout: 'admin',
	middleware: ['auth', 'platform-admin'],
});

// ── Current + latest version state ───────────────────────────────────────────

const config = useRuntimeConfig();
// String(): values reach runtime config through Nitro's env overlay, which
// destr's them, so a numeric-looking version would arrive as a number.
const currentVersion = computed(() => String(config.public.owlatVersion ?? '') || 'dev');

// Cached latest-release info from Convex (read-only, reactive)
const { data: latestRelease } = useConvexQuery(api.systemUpdates.getLatestRelease, () => ({}));

// Action to force a fresh GitHub poll
const convex = useConvex();
const checking = ref(false);
async function checkNow() {
	if (!convex) {
		showToast(t('dashboard.admin.system.index.toasts.noClient'), 'error');
		return;
	}
	checking.value = true;
	try {
		await convex.action(api.systemUpdatesReleaseCheck.checkForUpdates, { force: true });
		showToast(t('dashboard.admin.system.index.toasts.checkComplete'));
	} catch (err) {
		const msg = err instanceof Error ? err.message : t('dashboard.admin.system.index.unknownError');
		showToast(t('dashboard.admin.system.index.toasts.checkFailed', { error: msg }), 'error');
	} finally {
		checking.value = false;
	}
}

const updateAvailable = computed(() => {
	const latest = latestRelease.value?.latestVersion;
	const current = currentVersion.value;
	if (!latest || current === 'dev' || current === 'unknown') return false;
	return semverCompare(latest, current) > 0;
});

// ── Update history ───────────────────────────────────────────────────────────

const { data: history } = useConvexQuery(api.systemUpdates.listUpdateHistory, () => ({
	limit: 20,
}));

// ── Update flow ──────────────────────────────────────────────────────────────

// The run has real control flow — it outlives its own transport — so it lives in
// a composable rather than inline among this page's read-only cards.
const {
	updateState,
	updateSteps,
	updateError,
	updateWarning,
	updateAttempt,
	updateInProgress,
	pendingTargetVersion,
	startUpdate,
	cancelConfirm,
	confirmUpdate,
	onUpdateComplete,
	onUpdateStarted,
	onUpdateFailed,
} = useSystemUpdateRun(() => latestRelease.value?.latestVersion);

// ── Utility ──────────────────────────────────────────────────────────────────
function formatDuration(start?: number, end?: number) {
	if (!start || !end) return '—';
	const sec = Math.floor((end - start) / 1000);
	if (sec < 60) return t('dashboard.admin.system.index.duration.seconds', { seconds: sec });
	return t('dashboard.admin.system.index.duration.minutes', {
		minutes: Math.floor(sec / 60),
		seconds: sec % 60,
	});
}
</script>

<template>
	<div class="space-y-6">
		<!-- Page header -->
		<div>
			<h1 class="mt-2 text-2xl font-medium tracking-[-0.02em] text-text-primary">
				{{ t('dashboard.admin.system.index.title') }}
			</h1>
			<p class="mt-1 text-text-secondary text-md">
				{{ t('dashboard.admin.system.index.intro') }}
			</p>
		</div>

		<!-- Current version -->
		<SystemVersionCard />

		<!-- Container health -->
		<SystemContainerHealthCard />

		<!-- Network ports: which ports this instance's features need, and whether
		     the host's provider actually lets them through. Sits next to container
		     health because it answers the same question one layer down — a service
		     can be "running" and still be unreachable. -->
		<SystemPortChecksCard />

		<!-- LLM spend card (spend by feature + by provider + budget headroom) -->
		<SystemLlmSpendCard />

		<!-- Update check card -->
		<div class="card">
			<div class="flex items-start justify-between gap-4 flex-wrap">
				<div class="min-w-0">
					<h3 class="font-semibold text-text-primary mb-2">
						{{ t('dashboard.admin.system.index.updates.title') }}
					</h3>

					<template v-if="updateAvailable && latestRelease?.latestVersion">
						<div class="flex items-baseline gap-3 flex-wrap">
							<span class="text-lg font-semibold text-brand">
								v{{ latestRelease.latestVersion }}
							</span>
							<span class="text-caption text-text-tertiary">
								{{
									t('dashboard.admin.system.index.updates.availableCurrent', {
										version: currentVersion,
									})
								}}
							</span>
						</div>
						<p class="mt-1 text-caption text-text-tertiary">
							{{
								t('dashboard.admin.system.index.updates.released', {
									date: formatDateTime(latestRelease.publishedAt),
								})
							}}
						</p>
					</template>

					<template v-else-if="latestRelease?.latestVersion">
						<div class="flex items-baseline gap-2">
							<Icon name="lucide:check-circle-2" class="w-5 h-5 text-success" />
							<span class="text-text-primary font-medium">{{
								t('dashboard.admin.system.index.updates.upToDate')
							}}</span>
						</div>
						<p class="mt-1 text-caption text-text-tertiary">
							{{
								t('dashboard.admin.system.index.updates.latestChecked', {
									version: latestRelease.latestVersion,
									date: formatDateTime(latestRelease.checkedAt),
								})
							}}
						</p>
					</template>

					<template v-else>
						<p class="text-text-primary">
							{{ t('dashboard.admin.system.index.updates.neverChecked') }}
						</p>
					</template>
				</div>

				<div class="flex gap-2 flex-wrap">
					<UiButton variant="outline" size="sm" :disabled="checking" @click="checkNow">
						<Icon
							v-if="checking"
							name="lucide:loader-2"
							class="w-4 h-4 animate-spin motion-reduce:animate-none"
						/>
						<Icon v-else name="lucide:refresh-cw" class="w-4 h-4" />
						{{ t('dashboard.admin.system.index.updates.checkNow') }}
					</UiButton>

					<!-- Held while a run is in flight: a second run would only get the
					     updater's 409, after replacing the progress card with a confirm. -->
					<UiButton
						v-if="updateAvailable"
						variant="primary"
						size="sm"
						:disabled="updateInProgress"
						@click="startUpdate"
					>
						<Icon name="lucide:download" class="w-4 h-4" />
						{{ t('dashboard.admin.system.index.updates.updateNow') }}
					</UiButton>
				</div>
			</div>

			<!-- Release notes -->
			<details
				v-if="updateAvailable && latestRelease?.releaseNotes"
				class="mt-4 pt-4 border-t border-border-subtle"
			>
				<summary class="text-caption font-medium text-text-primary cursor-pointer hover:text-brand">
					{{ t('dashboard.admin.system.index.updates.releaseNotes') }}
				</summary>
				<pre
					class="mt-3 text-caption text-text-secondary whitespace-pre-wrap font-sans leading-relaxed"
					>{{ latestRelease.releaseNotes }}</pre>
			</details>

			<div v-if="latestRelease?.error" class="mt-3 text-xs text-warning">
				{{
					t('dashboard.admin.system.index.updates.lastCheckError', { error: latestRelease.error })
				}}
			</div>
		</div>

		<!-- Confirm dialog -->
		<div
			v-if="updateState === 'confirming'"
			class="rounded-xl border border-warning/40 bg-warning/5 p-6"
		>
			<h3 class="text-base font-semibold text-text-primary mb-2">
				{{ t('dashboard.admin.system.index.confirm.title', { version: pendingTargetVersion }) }}
			</h3>
			<p class="text-sm text-text-secondary mb-4">
				{{ t('dashboard.admin.system.index.confirm.body') }}
				<br /><br />
				<I18nT keypath="dashboard.admin.system.index.confirm.backupBody" tag="span" scope="global">
					<template #backupWarning>
						<strong>{{ t('dashboard.admin.system.index.confirm.backupWarning') }}</strong>
					</template>
				</I18nT>
			</p>
			<div class="flex gap-3">
				<UiButton variant="primary" size="sm" @click="confirmUpdate">{{
					t('dashboard.admin.system.index.confirm.submit')
				}}</UiButton>
				<UiButton variant="outline" size="sm" @click="cancelConfirm">{{
					t('common.cancel')
				}}</UiButton>
			</div>
		</div>

		<!-- In-flight progress -->
		<SystemUpdateProgress
			v-if="updateState === 'running'"
			:target-version="pendingTargetVersion"
			:steps="updateSteps ?? undefined"
			:attempt="updateAttempt"
			@complete="onUpdateComplete"
			@started="onUpdateStarted"
			@failed="onUpdateFailed"
		/>

		<!-- Success / failure banners -->
		<div
			v-if="updateState === 'success'"
			class="rounded-xl border border-success/40 bg-success/5 p-6"
		>
			<div class="flex items-start gap-3">
				<Icon name="lucide:check-circle-2" class="w-6 h-6 text-success shrink-0" />
				<div>
					<h3 class="font-semibold text-text-primary">
						{{ t('dashboard.admin.system.index.success.title') }}
					</h3>
					<p class="mt-1 text-sm text-text-secondary">
						{{ t('dashboard.admin.system.index.success.body', { version: pendingTargetVersion }) }}
					</p>
				</div>
			</div>
		</div>

		<!-- Applied and running, but the readiness check did not pass in time: a
		     warning, not a failure, so no retry is suggested. -->
		<div
			v-if="updateState === 'started'"
			class="rounded-xl border border-warning/40 bg-warning/5 p-6"
			role="status"
		>
			<div class="flex items-start gap-3">
				<Icon
					name="lucide:alert-triangle"
					class="w-6 h-6 text-warning shrink-0"
					aria-hidden="true"
				/>
				<div class="flex-1 min-w-0">
					<h3 class="font-semibold text-text-primary">
						{{ t('dashboard.admin.system.index.started.title') }}
					</h3>
					<I18nT
						keypath="dashboard.admin.system.index.started.body"
						tag="p"
						scope="global"
						class="mt-1 text-sm text-text-secondary"
					>
						<template #version>{{ pendingTargetVersion }}</template>
						<template #doctorCommand>
							<code class="font-mono text-xs bg-bg-surface px-1.5 py-0.5 rounded"
								>owlat doctor</code
							>
						</template>
					</I18nT>
					<p v-if="updateWarning" class="mt-3 text-caption text-text-secondary break-words">
						{{ updateWarning }}
					</p>
				</div>
			</div>
		</div>

		<div v-if="updateState === 'failed'" class="rounded-xl border border-error/40 bg-error/5 p-6">
			<div class="flex items-start gap-3">
				<Icon name="lucide:x-circle" class="w-6 h-6 text-error shrink-0" />
				<div class="flex-1 min-w-0">
					<h3 class="font-semibold text-text-primary">
						{{ t('dashboard.admin.system.index.failure.title') }}
					</h3>
					<p class="mt-1 text-sm text-error break-words">{{ updateError }}</p>
					<I18nT
						keypath="dashboard.admin.system.index.failure.recovery"
						tag="p"
						scope="global"
						class="mt-3 text-caption text-text-secondary"
					>
						<template #recoveryLink>
							<a
								href="https://docs.owlat.app/developer/self-hosting-maintenance#recovering-from-a-failed-update"
								target="_blank"
								rel="noopener"
								class="text-brand underline"
								>{{ t('dashboard.admin.system.index.failure.recoveryLink') }}</a
							>
						</template>
						<template #doctorCommand>
							<code class="font-mono text-xs bg-bg-surface px-1.5 py-0.5 rounded"
								>owlat doctor</code
							>
						</template>
					</I18nT>
				</div>
			</div>
		</div>

		<!-- Update history -->
		<div class="card">
			<h3 class="font-semibold text-text-primary mb-4">
				{{ t('dashboard.admin.system.index.history.title') }}
			</h3>

			<div v-if="!history || history.length === 0" class="text-caption text-text-tertiary">
				{{ t('dashboard.admin.system.index.history.empty') }}
			</div>

			<!-- Scroll container: a from→to version pair plus three more columns
			     does not fit a phone, and without this the card just clipped them.
			     The negative margin lets the scroll area bleed to the card's edges. -->
			<div v-else class="-mx-6 px-6 overflow-x-auto">
				<table class="w-full min-w-max text-caption">
					<thead>
						<tr class="border-b border-border-subtle text-text-tertiary">
							<th class="text-left py-2 font-medium">
								{{ t('dashboard.admin.system.index.history.fromTo') }}
							</th>
							<th class="text-left py-2 font-medium">
								{{ t('dashboard.admin.system.index.history.started') }}
							</th>
							<th class="text-left py-2 font-medium">
								{{ t('dashboard.admin.system.index.history.duration') }}
							</th>
							<th class="text-left py-2 font-medium">{{ t('common.status') }}</th>
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
							<td class="py-2 text-text-secondary">
								{{ formatDuration(row.startedAt, row.finishedAt) }}
							</td>
							<td class="py-2">
								<span
									class="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full"
									:class="{
										'bg-success/10 text-success': row.status === 'success',
										'bg-error/10 text-error': row.status === 'failed',
										'bg-brand/10 text-brand': row.status === 'running',
										'bg-bg-surface text-text-tertiary': row.status === 'superseded',
									}"
								>
									<span
										class="w-1.5 h-1.5 rounded-full"
										:class="{
											'bg-success': row.status === 'success',
											'bg-error': row.status === 'failed',
											'bg-brand animate-pulse motion-reduce:animate-none': row.status === 'running',
											'bg-text-tertiary': row.status === 'superseded',
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
	</div>
</template>
