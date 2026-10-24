<script setup lang="ts">
/**
 * Data migrations (Settings → System & updates, #1345): every migration this
 * release can run, with its state and progress from the migration ledger, and
 * the action that runs the pending ones (`migrations/admin:runPending`).
 *
 * Migrations run in the background as their own page chains and record their
 * progress, so this card only ever reports what the ledger says: a click
 * starts them, it does not finish them, and leaving the page loses nothing.
 * A migration started from the CLI or by a cron shows up here the same way.
 */
import { api } from '@owlat/api';
import { semverCompare } from '@owlat/shared/semver';
import { formatDateTime } from '~/utils/formatters';
import { workerServiceKey } from '~/utils/workerServices';
import {
	countByState,
	displayState,
	groupByRelease,
	isRunnable,
	isRunnerActive,
	migrationNameKey,
	type MigrationDisplayState,
	type MigrationRow,
	type MigrationWorkerWait,
} from '~/utils/systemMigrations';

const { t, te } = useI18n();
const { showToast } = useToast();

const { data, error, refetch } = useConvexQuery(api.migrations.admin.list, () => ({}));

// A running pass that stops moving turns interrupted without a new answer.
const now = useNow({ intervalMs: 30_000 });

const rows = computed<MigrationRow[]>(() => data.value?.migrations ?? []);
const runner = computed(() => data.value?.runner ?? null);
const counts = computed(() => countByState(rows.value, now.value));
const releases = computed(() => groupByRelease(rows.value, semverCompare));
const runnerActive = computed(() => isRunnerActive(runner.value, now.value));
const hasRunnable = computed(() =>
	rows.value.some((row) => isRunnable(displayState(row, now.value)))
);
const isEverythingCompleted = computed(
	() => rows.value.length > 0 && counts.value.completed === rows.value.length
);

/** What a contract step waits for on one worker service. */
function workerWaitText(wait: MigrationWorkerWait): string {
	const params = {
		service: t(`components.system.workerVersionsCard.services.${workerServiceKey(wait.service)}`),
		version: wait.requiredWireVersion,
		oldest: wait.oldestLiveWireVersion ?? 0,
	};
	return wait.reason === 'lagging'
		? t('components.system.migrationsCard.waitsForWorkersLagging', params)
		: t('components.system.migrationsCard.waitsForWorkersMissing', params);
}

function nameOf(migration: string): string {
	const key = `components.system.migrationsCard.names.${migrationNameKey(migration)}`;
	return te(key) ? t(key) : migration;
}

const STATE_CLASS: Record<MigrationDisplayState, { pill: string; dot: string }> = {
	pending: { pill: 'bg-bg-surface text-text-secondary', dot: 'bg-text-tertiary' },
	waiting: { pill: 'bg-bg-surface text-text-secondary', dot: 'bg-text-tertiary' },
	running: {
		pill: 'bg-brand/10 text-brand',
		dot: 'bg-brand animate-pulse motion-reduce:animate-none',
	},
	completed: { pill: 'bg-success/10 text-success', dot: 'bg-success' },
	failed: { pill: 'bg-error/10 text-error', dot: 'bg-error' },
	interrupted: { pill: 'bg-warning/10 text-warning', dot: 'bg-warning' },
};

const convex = useConvex();
const submitting = ref(false);

async function runPending() {
	if (!convex) {
		showToast(t('components.system.migrationsCard.toasts.noClient'), 'error');
		return;
	}
	submitting.value = true;
	try {
		const result = await convex.mutation(api.migrations.admin.runPending, {});
		if (result.outcome === 'started') {
			showToast(
				t('components.system.migrationsCard.toasts.started', {
					count: result.started.length + result.waiting.length,
				})
			);
		} else if (result.outcome === 'alreadyRunning') {
			showToast(t('components.system.migrationsCard.toasts.alreadyRunning'));
		} else if (result.outcome === 'nothingToRun') {
			showToast(t('components.system.migrationsCard.toasts.nothingToRun'));
		} else {
			showToast(
				t('components.system.migrationsCard.toasts.startFailed', {
					name: nameOf(result.failedMigration),
					error: result.error,
				}),
				'error'
			);
		}
	} catch (err) {
		const message =
			err instanceof Error ? err.message : t('components.system.migrationsCard.unknownError');
		showToast(t('components.system.migrationsCard.toasts.runFailed', { error: message }), 'error');
	} finally {
		submitting.value = false;
	}
}
</script>

<template>
	<div class="card">
		<div class="flex items-start justify-between gap-4 flex-wrap mb-4">
			<div class="min-w-0">
				<h3 class="font-semibold text-text-primary mb-1">
					{{ t('components.system.migrationsCard.title') }}
				</h3>
				<p class="text-caption text-text-tertiary max-w-2xl">
					{{ t('components.system.migrationsCard.intro') }}
				</p>
			</div>
			<UiButton
				v-if="data"
				variant="primary"
				size="sm"
				:disabled="submitting || runnerActive || !hasRunnable"
				data-test="run-pending"
				@click="runPending"
			>
				<Icon
					v-if="submitting || runnerActive"
					name="lucide:loader-2"
					class="w-4 h-4 animate-spin motion-reduce:animate-none"
				/>
				<Icon v-else name="lucide:play" class="w-4 h-4" />
				{{ t('components.system.migrationsCard.runPending') }}
			</UiButton>
		</div>

		<!-- A failed read is not "nothing to run": show the error. -->
		<UiQueryBoundary v-if="error" :error="error" @retry="refetch" />

		<div v-else-if="!data" class="text-caption text-text-tertiary">
			{{ t('components.system.migrationsCard.loading') }}
		</div>

		<template v-else>
			<div class="mb-4 space-y-2">
				<p
					v-if="runnerActive"
					class="flex items-start gap-2 rounded-lg border border-brand/30 bg-brand/5 p-3 text-caption text-text-primary"
					role="status"
				>
					<Icon
						name="lucide:loader-2"
						class="w-4 h-4 text-brand shrink-0 mt-0.5"
						aria-hidden="true"
					/>
					{{ t('components.system.migrationsCard.runnerActive') }}
				</p>
				<div
					v-else-if="runner?.status === 'stopped' && !isEverythingCompleted"
					class="flex items-start gap-2 rounded-lg border border-error/40 bg-error/5 p-3 text-caption text-text-primary"
					role="alert"
				>
					<Icon
						name="lucide:x-circle"
						class="w-4 h-4 text-error shrink-0 mt-0.5"
						aria-hidden="true"
					/>
					<div class="min-w-0">
						<p>
							{{
								t('components.system.migrationsCard.runnerStopped', {
									name: nameOf(runner.stoppedMigration ?? ''),
								})
							}}
						</p>
						<p v-if="runner.stoppedError" class="mt-1 font-mono text-xs text-error break-words">
							{{ runner.stoppedError }}
						</p>
					</div>
				</div>
				<p
					v-if="isEverythingCompleted"
					class="flex items-center gap-2 text-caption text-text-secondary"
				>
					<Icon name="lucide:check-circle-2" class="w-4 h-4 text-success" aria-hidden="true" />
					{{ t('components.system.migrationsCard.allCompleted') }}
				</p>
				<p v-else class="text-caption text-text-secondary" data-test="summary">
					{{
						t('components.system.migrationsCard.summary', {
							pending: counts.pending + counts.waiting,
							running: counts.running,
							stopped: counts.failed + counts.interrupted,
							completed: counts.completed,
						})
					}}
				</p>
			</div>

			<div v-for="release in releases" :key="release.version" class="mt-4 first:mt-0">
				<h4 class="text-xs font-medium uppercase tracking-wide text-text-tertiary mb-1">
					{{ t('components.system.migrationsCard.introducedIn', { version: release.version }) }}
				</h4>
				<ul class="divide-y divide-border-subtle">
					<li
						v-for="row in release.rows"
						:key="row.migration"
						class="py-3"
						:data-test="`migration-${row.migration}`"
					>
						<div class="flex items-start justify-between gap-3 flex-wrap">
							<div class="min-w-0">
								<p class="text-sm font-medium text-text-primary">{{ nameOf(row.migration) }}</p>
								<p class="font-mono text-xs text-text-tertiary break-all">{{ row.migration }}</p>
							</div>
							<span
								class="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full shrink-0"
								:class="STATE_CLASS[displayState(row, now)].pill"
							>
								<span
									class="w-1.5 h-1.5 rounded-full"
									:class="STATE_CLASS[displayState(row, now)].dot"
								/>
								{{ t(`components.system.migrationsCard.state.${displayState(row, now)}`) }}
							</span>
						</div>

						<div class="mt-1 space-y-1 text-caption text-text-secondary">
							<p v-if="row.progress">
								{{
									t('components.system.migrationsCard.progress', {
										scanned: row.progress.scannedCount.toLocaleString(),
										changed: row.progress.changedCount.toLocaleString(),
									})
								}}
								<template v-if="row.progress.completedAt">
									·
									{{
										t('components.system.migrationsCard.completedAt', {
											date: formatDateTime(row.progress.completedAt),
										})
									}}
								</template>
								<template v-else>
									·
									{{
										t('components.system.migrationsCard.lastProgress', {
											date: formatDateTime(row.progress.updatedAt),
										})
									}}
								</template>
							</p>
							<p v-if="displayState(row, now) === 'waiting' && row.waitingFor.length > 0">
								{{
									t('components.system.migrationsCard.waitsFor', {
										names: row.waitingFor.map(nameOf).join(', '),
									})
								}}
							</p>
							<!-- A contract step: it starts once every worker has moved. -->
							<p
								v-for="wait in row.waitingForWorkers ?? []"
								:key="wait.service"
								:data-test="`worker-wait-${wait.service}`"
							>
								{{ workerWaitText(wait) }}
							</p>
							<p v-if="displayState(row, now) === 'interrupted'" class="text-warning">
								{{ t('components.system.migrationsCard.interruptedHint') }}
							</p>
							<template v-if="displayState(row, now) === 'failed'">
								<p class="font-mono text-xs text-error break-words">{{ row.error }}</p>
								<p>{{ t('components.system.migrationsCard.failedHint') }}</p>
							</template>
							<!-- A recorded failure stops the cron's resumes (0054's ensure), so
							     that row must not promise that it starts by itself. -->
							<p v-if="row.startsItself && row.state !== 'completed'">
								{{
									row.hasRecordedFailure
										? t('components.system.migrationsCard.startsItselfStopped')
										: t('components.system.migrationsCard.startsItself')
								}}
							</p>
							<p
								v-if="row.isSteppingStone && row.state !== 'completed'"
								class="flex items-start gap-1.5 text-warning"
							>
								<Icon
									name="lucide:alert-triangle"
									class="w-3.5 h-3.5 shrink-0 mt-0.5"
									aria-hidden="true"
								/>
								{{
									row.requiredBefore
										? t('components.system.migrationsCard.steppingStoneBefore', {
												version: row.requiredBefore,
											})
										: t('components.system.migrationsCard.steppingStone', {
												version: row.introducedIn,
											})
								}}
							</p>
						</div>
					</li>
				</ul>
			</div>
		</template>
	</div>
</template>
