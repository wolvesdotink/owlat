<script setup lang="ts">
import { api } from '@owlat/api';
import { formatDateTime } from '~/utils/formatters';

const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.admin.backups.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', 'platform-admin'],
});

const { showToast } = useToast();

// Recorded backup plan (operator attestation — NOT a live host reading; see
// apps/api/convex/backups.ts for why the app can't introspect the host).
const { data: state, isLoading, error } = useConvexQuery(api.backups.getBackupState, () => ({}));

const { run: setSchedule, isLoading: savingSchedule } = useBackendOperation(
	api.backups.setScheduleEnabled,
	{ label: () => t('dashboard.admin.backups.updateScheduleOperation') }
);
const { run: logRun, isLoading: loggingRun } = useBackendOperation(api.backups.logManualRun, {
	label: () => t('dashboard.admin.backups.logRunOperation'),
});

// The exact commands the operator runs on their server. These match the CLI
// vocabulary the quickstart summary and `scripts/owlat` dispatcher teach
// (`owlat backup`, `owlat restore <archive>`, `owlat backup-schedule …`), so
// there is one command spelling to learn — the panel records what you ran, it
// does not run anything for you.
const CMD_ENABLE = 'owlat backup-schedule enable';
const CMD_DISABLE = 'owlat backup-schedule disable';
const CMD_STATUS = 'owlat backup-schedule status';
const CMD_RUN = 'owlat backup';
const CMD_RESTORE = 'owlat restore ./backups/owlat-YYYYMMDD-HHMMSS.tar.gz';

const isScheduleEnabled = computed(() => state.value?.isScheduleEnabled ?? false);

// Commands shown under the schedule section: the toggle command for the state
// you are moving to, then the status check.
const scheduleCommands = computed(() => [
	isScheduleEnabled.value ? CMD_DISABLE : CMD_ENABLE,
	CMD_STATUS,
]);

async function toggleSchedule(next: boolean) {
	// Attest what you set up on the host. Run the shown command first.
	const res = await setSchedule({ enabled: next });
	if (res.ok) {
		showToast(
			next
				? t('dashboard.admin.backups.toastScheduleEnabled')
				: t('dashboard.admin.backups.toastScheduleDisabled'),
			'success'
		);
	}
}

async function recordRun(status: 'success' | 'failed') {
	const res = await logRun({ status });
	if (res.ok) {
		showToast(
			status === 'success'
				? t('dashboard.admin.backups.toastRunLogged')
				: t('dashboard.admin.backups.toastFailedRunLogged'),
			'success'
		);
	}
}

const lastRunLabel = computed(() =>
	state.value?.lastRunAt ? formatDateTime(state.value.lastRunAt, locale.value) : ''
);
const recordedAtLabel = computed(() =>
	state.value?.updatedAt ? formatDateTime(state.value.updatedAt, locale.value) : ''
);
</script>

<template>
	<div class="mx-auto max-w-3xl p-6 lg:p-8 space-y-6">
		<!-- Header -->
		<div>
			<NuxtLink
				to="/dashboard/admin"
				class="text-sm text-text-tertiary hover:text-brand transition-colors"
			>
				← {{ t('common.settings') }}
			</NuxtLink>
			<h1 class="mt-2 text-2xl font-medium tracking-[-0.02em] text-text-primary">
				{{ t('dashboard.admin.backups.title') }}
			</h1>
			<p class="mt-1 text-text-secondary">
				{{ t('dashboard.admin.backups.intro') }}
			</p>
		</div>

		<!-- Honesty note: the app records what you've set up; the server is the
		     source of truth. No dead buttons — everything here is copy-paste + record. -->
		<div
			class="flex items-start gap-3 rounded-xl border border-border-subtle bg-bg-surface p-4 text-sm text-text-secondary"
		>
			<Icon name="lucide:info" class="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
			<I18nT keypath="dashboard.admin.backups.honestyNote" tag="p" scope="global">
				<template #you>
					<span class="font-medium text-text-primary">{{
						t('dashboard.admin.backups.honestyNoteYou')
					}}</span>
				</template>
			</I18nT>
		</div>

		<UiQueryBoundary
			:loading="isLoading"
			:error="error"
			:error-title="t('dashboard.admin.backups.loadErrorTitle')"
		>
			<template #loading>
				<div class="space-y-4">
					<UiSkeleton class="h-28 w-full" />
					<UiSkeleton class="h-40 w-full" />
				</div>
			</template>

			<div class="space-y-6">
				<!-- Current recorded status -->
				<section class="rounded-xl border border-border-default bg-bg-elevated p-6">
					<h2 class="text-sm font-medium uppercase tracking-wider text-text-tertiary">
						{{ t('dashboard.admin.backups.currentStatus') }}
					</h2>

					<div v-if="!state" class="mt-4">
						<UiEmptyState
							icon="lucide:shield-off"
							:title="t('dashboard.admin.backups.noPlanTitle')"
							:description="t('dashboard.admin.backups.noPlanDescription')"
						/>
					</div>

					<div v-else class="mt-4 space-y-4">
						<div class="flex flex-wrap items-center justify-between gap-3">
							<div>
								<p class="text-sm text-text-secondary">
									{{ t('dashboard.admin.backups.dailySchedule') }}
								</p>
								<p class="text-lg font-semibold text-text-primary">
									{{
										isScheduleEnabled
											? t('dashboard.admin.backups.scheduled')
											: t('dashboard.admin.backups.notScheduled')
									}}
								</p>
							</div>
							<UiBadge :variant="isScheduleEnabled ? 'success' : 'warning'">
								{{
									isScheduleEnabled
										? t('dashboard.admin.backups.protected')
										: t('dashboard.admin.backups.atRisk')
								}}
							</UiBadge>
						</div>

						<div class="border-t border-border-subtle pt-4">
							<p class="text-sm text-text-secondary">
								{{ t('dashboard.admin.backups.lastLoggedBackup') }}
							</p>
							<p v-if="state.lastRunAt" class="text-text-primary">
								{{ lastRunLabel }}
								<span
									class="ml-2 text-sm font-medium"
									:class="state.lastRunStatus === 'success' ? 'text-success' : 'text-error'"
								>
									·
									{{
										state.lastRunStatus === 'success'
											? t('dashboard.admin.backups.runSucceeded')
											: t('dashboard.admin.backups.runFailed')
									}}
								</span>
							</p>
							<p v-else class="text-text-tertiary">
								{{ t('dashboard.admin.backups.noRunsLogged') }}
							</p>
						</div>

						<p v-if="state.updatedBy" class="text-xs text-text-tertiary">
							{{
								t('dashboard.admin.backups.recordedBy', {
									name: state.updatedBy,
									date: recordedAtLabel,
								})
							}}
						</p>
					</div>
				</section>

				<!-- Daily schedule -->
				<section class="rounded-xl border border-border-default bg-bg-elevated p-6 space-y-4">
					<div class="flex flex-wrap items-start justify-between gap-4">
						<div class="min-w-0">
							<h2 class="text-sm font-medium uppercase tracking-wider text-text-tertiary">
								{{ t('dashboard.admin.backups.dailySchedule') }}
							</h2>
							<p class="mt-1 text-sm text-text-secondary">
								{{ t('dashboard.admin.backups.dailyScheduleDescription') }}
							</p>
						</div>
						<UiSwitch
							:model-value="isScheduleEnabled"
							:disabled="savingSchedule"
							:label="t('dashboard.admin.backups.scheduleSwitchLabel')"
							@update:model-value="toggleSchedule"
						/>
					</div>

					<div class="space-y-3">
						<BackupCommandRow v-for="cmd in scheduleCommands" :key="cmd" :command="cmd" />
					</div>
				</section>

				<!-- Run now -->
				<section class="rounded-xl border border-border-default bg-bg-elevated p-6 space-y-4">
					<div>
						<h2 class="text-sm font-medium uppercase tracking-wider text-text-tertiary">
							{{ t('dashboard.admin.backups.backUpNow') }}
						</h2>
						<p class="mt-1 text-sm text-text-secondary">
							{{ t('dashboard.admin.backups.backUpNowDescription') }}
						</p>
					</div>

					<BackupCommandRow :command="CMD_RUN" />

					<div class="flex flex-wrap items-center gap-3">
						<UiButton
							variant="secondary"
							size="sm"
							:loading="loggingRun"
							@click="recordRun('success')"
						>
							{{ t('dashboard.admin.backups.logSuccess') }}
						</UiButton>
						<UiButton variant="ghost" size="sm" :disabled="loggingRun" @click="recordRun('failed')">
							{{ t('dashboard.admin.backups.logFailure') }}
						</UiButton>
					</div>
				</section>

				<!-- Restore -->
				<section class="rounded-xl border border-border-default bg-bg-elevated p-6 space-y-4">
					<div>
						<h2 class="text-sm font-medium uppercase tracking-wider text-text-tertiary">
							{{ t('dashboard.admin.backups.restore') }}
						</h2>
						<I18nT
							keypath="dashboard.admin.backups.restoreDescription"
							tag="p"
							scope="global"
							class="mt-1 text-sm text-text-secondary"
						>
							<template #path><code class="font-mono text-text-primary">./backups</code></template>
						</I18nT>
					</div>

					<BackupCommandRow :command="CMD_RESTORE" />

					<!-- Sealed Mail / instance-secret warning: sealed history is unrecoverable
					     without the instance secret OR the per-address recovery kits. -->
					<div class="rounded-lg border border-warning/40 bg-warning/5 p-4">
						<div class="flex items-start gap-3">
							<Icon name="lucide:key-round" class="mt-0.5 h-4 w-4 shrink-0 text-warning" />
							<div class="space-y-2">
								<p class="text-sm font-medium text-text-primary">
									{{ t('dashboard.admin.backups.sealedMailTitle') }}
								</p>
								<I18nT
									keypath="dashboard.admin.backups.sealedMailBody"
									tag="p"
									scope="global"
									class="text-sm text-text-secondary"
								>
									<template #secret>
										<code class="font-mono text-text-primary">INSTANCE_SECRET</code>
									</template>
								</I18nT>
								<p class="text-sm text-text-secondary">
									{{ t('dashboard.admin.backups.sealedMailWarning') }}
								</p>
								<NuxtLink
									to="/dashboard/admin/instance/sealed-mail"
									class="inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:underline"
								>
									{{ t('dashboard.admin.backups.sealedMailLink') }}
									<Icon name="lucide:arrow-right" class="h-3.5 w-3.5" />
								</NuxtLink>
							</div>
						</div>
					</div>

					<p class="text-xs text-text-tertiary">
						{{ t('dashboard.admin.backups.restoreWarning') }}
					</p>
				</section>
			</div>
		</UiQueryBoundary>
	</div>
</template>
