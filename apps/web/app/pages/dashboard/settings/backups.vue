<script setup lang="ts">
import { api } from '@owlat/api';
import { formatDateTime } from '~/utils/formatters';

useHead({ title: 'Backups — Owlat' });

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
	{ label: 'Update backup schedule' }
);
const { run: logRun, isLoading: loggingRun } = useBackendOperation(api.backups.logManualRun, {
	label: 'Log backup run',
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
	if (res) {
		showToast(
			next ? 'Recorded: daily backups scheduled' : 'Recorded: daily backups disabled',
			'success'
		);
	}
}

async function recordRun(status: 'success' | 'failed') {
	const res = await logRun({ status });
	if (res) {
		showToast(status === 'success' ? 'Backup logged' : 'Failed run logged', 'success');
	}
}
</script>

<template>
	<div class="mx-auto max-w-3xl p-6 lg:p-8 space-y-6">
		<!-- Header -->
		<div>
			<NuxtLink
				to="/dashboard/settings"
				class="text-sm text-text-tertiary hover:text-brand transition-colors"
			>
				← Settings
			</NuxtLink>
			<h1 class="mt-2 text-2xl font-semibold text-text-primary">Backups</h1>
			<p class="mt-1 text-text-secondary">
				Keep a safe copy of your mail, contacts, and settings. Set backups up before you store real
				data.
			</p>
		</div>

		<!-- Honesty note: the app records what you've set up; the server is the
		     source of truth. No dead buttons — everything here is copy-paste + record. -->
		<div
			class="flex items-start gap-3 rounded-xl border border-border-subtle bg-bg-surface p-4 text-sm text-text-secondary"
		>
			<Icon name="lucide:info" class="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
			<p>
				Owlat can't read your server's schedule from here, so this page tracks the plan
				<span class="font-medium text-text-primary">you</span> record. Run the commands shown on
				your server, then note here what you set up — that's how the app knows your data is
				protected.
			</p>
		</div>

		<UiQueryBoundary :loading="isLoading" :error="error" error-title="Couldn't load backup status">
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
						Current status
					</h2>

					<div v-if="!state" class="mt-4">
						<UiEmptyState
							icon="lucide:shield-off"
							title="No backup plan recorded yet"
							description="Nothing here is protected until you schedule backups on your server. Follow the steps below, then record what you set up."
						/>
					</div>

					<div v-else class="mt-4 space-y-4">
						<div class="flex flex-wrap items-center justify-between gap-3">
							<div>
								<p class="text-sm text-text-secondary">Daily schedule</p>
								<p class="text-lg font-semibold text-text-primary">
									{{ isScheduleEnabled ? 'Scheduled' : 'Not scheduled' }}
								</p>
							</div>
							<UiBadge :variant="isScheduleEnabled ? 'success' : 'warning'">
								{{ isScheduleEnabled ? 'Protected' : 'At risk' }}
							</UiBadge>
						</div>

						<div class="border-t border-border-subtle pt-4">
							<p class="text-sm text-text-secondary">Last backup you logged</p>
							<p v-if="state.lastRunAt" class="text-text-primary">
								{{ formatDateTime(state.lastRunAt) }}
								<span
									class="ml-2 text-sm font-medium"
									:class="state.lastRunStatus === 'success' ? 'text-success' : 'text-error'"
								>
									· {{ state.lastRunStatus === 'success' ? 'succeeded' : 'failed' }}
								</span>
							</p>
							<p v-else class="text-text-tertiary">No manual runs logged yet.</p>
						</div>

						<p v-if="state.updatedBy" class="text-xs text-text-tertiary">
							Recorded by {{ state.updatedBy }} on {{ formatDateTime(state.updatedAt) }}.
						</p>
					</div>
				</section>

				<!-- Daily schedule -->
				<section class="rounded-xl border border-border-default bg-bg-elevated p-6 space-y-4">
					<div class="flex flex-wrap items-start justify-between gap-4">
						<div class="min-w-0">
							<h2 class="text-sm font-medium uppercase tracking-wider text-text-tertiary">
								Daily schedule
							</h2>
							<p class="mt-1 text-sm text-text-secondary">
								Runs a backup every night. Enable it on your server, then flip this switch to record
								it.
							</p>
						</div>
						<UiSwitch
							:model-value="isScheduleEnabled"
							:disabled="savingSchedule"
							label="Daily backups scheduled"
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
							Back up now
						</h2>
						<p class="mt-1 text-sm text-text-secondary">
							Run this on your server for an immediate backup, then log the result here.
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
							Log a successful backup
						</UiButton>
						<UiButton variant="ghost" size="sm" :disabled="loggingRun" @click="recordRun('failed')">
							Log a failed run
						</UiButton>
					</div>
				</section>

				<!-- Restore -->
				<section class="rounded-xl border border-border-default bg-bg-elevated p-6 space-y-4">
					<div>
						<h2 class="text-sm font-medium uppercase tracking-wider text-text-tertiary">Restore</h2>
						<p class="mt-1 text-sm text-text-secondary">
							Backups are written to
							<code class="font-mono text-text-primary">./backups</code> on your server. To restore
							one, run:
						</p>
					</div>

					<BackupCommandRow :command="CMD_RESTORE" />

					<!-- Sealed Mail / instance-secret warning: sealed history is unrecoverable
					     without the instance secret OR the per-address recovery kits. -->
					<div class="rounded-lg border border-warning/40 bg-warning/5 p-4">
						<div class="flex items-start gap-3">
							<Icon name="lucide:key-round" class="mt-0.5 h-4 w-4 shrink-0 text-warning" />
							<div class="space-y-2">
								<p class="text-sm font-medium text-text-primary">
									Sealed Mail and your instance secret
								</p>
								<p class="text-sm text-text-secondary">
									Mail that arrives sealed is stored encrypted. The only things that can open it
									again are your instance secret (<code class="font-mono text-text-primary"
										>INSTANCE_SECRET</code
									>) and the recovery kits you download from Sealed Mail settings.
								</p>
								<p class="text-sm text-text-secondary">
									If you lose the instance secret and haven't kept any recovery kits, sealed mail
									you already received can no longer be opened, and a database backup alone will not
									bring it back. Keep the instance secret in your backups, and download a recovery
									kit for each address before you rely on Sealed Mail.
								</p>
								<NuxtLink
									to="/dashboard/settings/sealed-mail"
									class="inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:underline"
								>
									Go to Sealed Mail settings
									<Icon name="lucide:arrow-right" class="h-3.5 w-3.5" />
								</NuxtLink>
							</div>
						</div>
					</div>

					<p class="text-xs text-text-tertiary">
						Restoring replaces current data with the snapshot — stop the stack and confirm the
						tarball before running it in production.
					</p>
				</section>
			</div>
		</UiQueryBoundary>
	</div>
</template>
