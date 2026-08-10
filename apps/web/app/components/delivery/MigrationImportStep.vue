<script setup lang="ts">
/**
 * The migration flow's carry-over step: contacts, then suppressions.
 *
 * TWO RUNS, STRICTLY IN ORDER, because the backend enforces it. One import may
 * be in flight at a time — `startIntegrationImport` throws `invalid_state` while
 * another run is `running` — so this step is a small state machine that starts
 * the Mailchimp run, watches `getImportProgress` for THAT run's id to leave
 * `running`, and only then starts the Mandrill reject-list run. Firing both and
 * hoping is how the second one silently never happens.
 *
 * WHY IT TRACKS THE ID. `getImportProgress` answers with one run: the running
 * one, or else the most recent. Between "start" and the scheduler's first hop,
 * and again after a run completes, that answer is a DIFFERENT run than the one
 * this step is waiting on — so completion is judged on `_id`, never on status
 * alone.
 *
 * RE-RUNNING IS FREE. Both imports are idempotent per lowercased email, so there
 * is no confirmation dialog: a second pass over an unchanged Mandrill blacklist
 * carries nothing and says so.
 *
 * Self-querying and self-mutating, like `<DeliveryRelayDomainStatus />`, so
 * the flow page stays a composition of steps rather than a controller for them.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	carriedSuppressionCounts,
	type MigrationSuppressionCounts,
} from '~/utils/mandrillMigration';

const props = defineProps<{
	/** Set while an earlier step is outstanding; the run button stays disabled. */
	readonly isBlocked?: boolean;
	readonly blockedReason?: string | null;
}>();

const emit = defineEmits<{ (event: 'carried', value: boolean): void }>();

type Phase = 'idle' | 'contacts' | 'suppressions' | 'done' | 'failed';

const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const isMailchimpEnabled = computed(() => isFeatureEnabled('imports.mailchimp'));
const isMandrillEnabled = computed(() => isFeatureEnabled('imports.mandrill'));

const apiKey = ref('');
const listId = ref('');
const phase = ref<Phase>('idle');
const trackedId = ref<string | null>(null);
const failure = ref<string | null>(null);
const contactsSummary = ref<{ imported: number; updated: number; skipped: number } | null>(null);
const carried = ref<readonly { label: string; value: number }[] | null>(null);

const convexClient = useConvex();
/** The client is null before the plugin installs it; starting an import then is a bug, not a state. */
function convex(): NonNullable<typeof convexClient> {
	if (!convexClient) throw new Error('Convex client is not available');
	return convexClient;
}
const { showToast } = useToast();
const { data: progress } = useConvexQuery(
	api.integrationImports.walker.getImportProgress,
	() => ({})
);

const isRunning = computed(() => phase.value === 'contacts' || phase.value === 'suppressions');

/** Mailchimp keys are `<key>-<datacenter>`; the list id is the audience. */
const canStart = computed(() => {
	if (props.isBlocked === true || isRunning.value) return false;
	if (!isMailchimpEnabled.value && !isMandrillEnabled.value) return false;
	if (!isMailchimpEnabled.value) return true;
	return apiKey.value.includes('-') && listId.value.trim().length > 0;
});

const runLabel = computed(() => {
	if (phase.value === 'contacts') return 'Importing contacts…';
	if (phase.value === 'suppressions') return 'Importing suppressions…';
	if (phase.value === 'done' || phase.value === 'failed') return 'Run the carry-over again';
	return 'Start the carry-over';
});

async function startMandrillSuppressions(): Promise<void> {
	if (!isMandrillEnabled.value) {
		phase.value = 'done';
		emit('carried', true);
		return;
	}
	phase.value = 'suppressions';
	// No credential field: the reject-list import reads MANDRILL_API_KEY from the
	// deployment environment (plan D2), which is the key step 1 already checked.
	const importId = await convex().mutation(api.integrationImports.walker.startIntegrationImport, {
		config: { provider: 'mandrill' },
		handleDuplicates: 'skip',
	});
	trackedId.value = importId as string;
}

async function start(): Promise<void> {
	failure.value = null;
	carried.value = null;
	contactsSummary.value = null;
	try {
		if (isMailchimpEnabled.value) {
			phase.value = 'contacts';
			const importId = await convex().mutation(
				api.integrationImports.walker.startIntegrationImport,
				{
					config: {
						provider: 'mailchimp',
						apiKey: apiKey.value.trim(),
						listId: listId.value.trim(),
						// D9: the unsubscribes and cleaned addresses come across in the
						// same pass as the audience. A migration that carried contacts
						// but not their opt-outs would re-mail people who left.
						importSuppressions: true,
					},
					handleDuplicates: 'skip',
				}
			);
			trackedId.value = importId as string;
			return;
		}
		await startMandrillSuppressions();
	} catch (error) {
		phase.value = 'failed';
		failure.value = error instanceof Error ? error.message : 'The import could not be started.';
		showToast(failure.value, 'error');
	}
}

async function cancel(): Promise<void> {
	const id = trackedId.value;
	if (id === null) return;
	try {
		await convex().mutation(api.integrationImports.walker.cancelImport, {
			importId: id as Id<'integrationImports'>,
		});
	} catch {
		// A run that finished between render and click is not an error worth a
		// toast — the watcher below is about to report its real outcome.
	}
}

/**
 * The completion gate. Only the tracked run's terminal status advances the
 * machine; every other answer this query gives belongs to a different run.
 */
watch(
	() => progress.value,
	(run) => {
		if (!run || trackedId.value === null || run._id !== trackedId.value) return;
		if (run.status === 'running') return;
		if (run.status === 'failed') {
			phase.value = 'failed';
			failure.value = run.errors?.[0] ?? 'The import failed.';
			emit('carried', false);
			return;
		}
		const counts = run.suppressionCounts as MigrationSuppressionCounts | undefined;
		if (counts !== undefined) carried.value = carriedSuppressionCounts(counts);
		if (phase.value === 'contacts') {
			contactsSummary.value = {
				imported: run.imported,
				updated: run.updated,
				skipped: run.skipped,
			};
			void startMandrillSuppressions().catch((error: unknown) => {
				phase.value = 'failed';
				failure.value =
					error instanceof Error ? error.message : 'The suppression import could not be started.';
			});
			return;
		}
		if (phase.value === 'suppressions') {
			phase.value = 'done';
			emit('carried', true);
		}
	},
	{ deep: false }
);

const progressText = computed(() => {
	const run = progress.value;
	if (!run || run._id !== trackedId.value) return '';
	const total = run.imported + run.updated + run.skipped + run.failed;
	return `${total.toLocaleString()} processed`;
});
</script>

<template>
	<div class="space-y-4" data-testid="migration-import-step">
		<p v-if="isBlocked" class="text-sm text-warning" data-testid="migration-import-blocked">
			{{ blockedReason }}
		</p>

		<p
			v-if="!isMailchimpEnabled && !isMandrillEnabled"
			class="text-sm text-warning"
			data-testid="migration-import-flags-off"
		>
			Both integration imports are switched off for this workspace. Turn on
			<strong>Mailchimp import</strong> and <strong>Mandrill suppression import</strong> under
			<NuxtLink to="/dashboard/settings/features" class="underline">Settings → Features</NuxtLink>
			to carry your history across.
		</p>

		<div v-if="isMailchimpEnabled" class="grid gap-3 sm:grid-cols-2">
			<div>
				<label for="migration-mailchimp-key" class="block text-sm text-text-secondary mb-1">
					Mailchimp Marketing API key
				</label>
				<UiInput
					id="migration-mailchimp-key"
					v-model="apiKey"
					type="password"
					placeholder="abc123…-us21"
					:disabled="isRunning"
					data-testid="migration-mailchimp-key"
				/>
			</div>
			<div>
				<label for="migration-mailchimp-list" class="block text-sm text-text-secondary mb-1">
					Audience (list) ID
				</label>
				<UiInput
					id="migration-mailchimp-list"
					v-model="listId"
					placeholder="a1b2c3d4e5"
					:disabled="isRunning"
					data-testid="migration-mailchimp-list"
				/>
			</div>
		</div>

		<p class="text-sm text-text-tertiary">
			Contacts and their Mailchimp unsubscribes import first; Mandrill's reject list follows on its
			own. Only one import runs at a time, so the second starts when the first finishes. Running
			this again later is safe — every address is matched on its email, so nothing is duplicated.
		</p>

		<div class="flex items-center gap-3">
			<UiButton :disabled="!canStart" data-testid="migration-import-run" @click="start">
				{{ runLabel }}
			</UiButton>
			<UiButton
				v-if="isRunning"
				variant="secondary"
				data-testid="migration-import-cancel"
				@click="cancel"
			>
				Cancel
			</UiButton>
			<span
				v-if="isRunning"
				class="text-sm text-text-secondary"
				data-testid="migration-import-progress"
			>
				{{ progressText }}
			</span>
		</div>

		<p v-if="failure" class="text-sm text-error" data-testid="migration-import-error">
			{{ failure }}
		</p>

		<div
			v-if="contactsSummary"
			class="text-sm text-text-secondary"
			data-testid="migration-import-contacts"
		>
			Contacts: {{ contactsSummary.imported.toLocaleString() }} imported,
			{{ contactsSummary.updated.toLocaleString() }} updated,
			{{ contactsSummary.skipped.toLocaleString() }} skipped.
		</div>

		<div v-if="carried" class="text-sm" data-testid="migration-import-carried">
			<template v-if="carried.length">
				<span class="text-text-secondary">Carried over:</span>
				<span
					v-for="entry in carried"
					:key="entry.label"
					class="ml-2 text-text-primary"
					data-testid="migration-carried-count"
				>
					{{ entry.value.toLocaleString() }} {{ entry.label }}
				</span>
			</template>
			<span v-else class="text-text-secondary">
				Nothing new to carry — the suppression list here already matches.
			</span>
		</div>

		<p v-if="phase === 'done'" class="text-sm text-success" data-testid="migration-import-done">
			History carried over.
		</p>
	</div>
</template>
