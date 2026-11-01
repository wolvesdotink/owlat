<script setup lang="ts">
import { postboxPageTransition } from '~/utils/postboxPageTransition';
import { MAIL_SYNC_MAX_RAW_MESSAGE_BYTES } from '@owlat/shared/mailSyncLimits';
import type { MailProvider } from '~/utils/mailAutodiscover';
import { canLearnFromImport } from '~/composables/postbox/useMailMigration';
import { MAIL_PROVIDERS, providerForImapHost } from '~/utils/mailAutodiscover';
import type { Id } from '@owlat/api/dataModel';
import {
	CircleCheckIcon,
	CircleSlashIcon,
	DownloadIcon,
	KeyIcon,
	LockIcon,
	SparklesIcon,
	TriangleWarningIcon,
} from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const { t } = useI18n();

useHead({ title: () => t('dashboard.postbox.migrate.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', postboxPageTransition],
});

const route = useRoute();
const router = useRouter();
const { showToast } = useToast();
const { isEnabled, isLoading: flagsLoading } = useFeatureFlag();
// Gate inline rather than via requiresAnyFeature: when external mailboxes are
// turned off the wizard explains itself instead of silently redirecting away.
// While the flags subscription is still resolving, `isEnabled` returns the
// default (false) — so on a hard reload / deep link (the c1 onboarding entry
// path) we must show a loading state, not flash the "turned off" lock card at
// users who actually have the feature enabled.
const externalEnabled = computed(() => isEnabled('mail.external'));

const {
	migration,
	account,
	step,
	importPercent,
	indexPercent,
	isAiIndexing,
	isDiscovering,
	isPaused,
	resumesAtLabel,
	failureMessage,
	start,
	cancel,
	learn,
	startBusy,
	cancelBusy,
	learnBusy,
} = useMailMigration();

// ── Provider pick (connect step) ────────────────────────────────────────────
const selectedProvider = ref<MailProvider | null>(null);
function pickProvider(provider: MailProvider) {
	selectedProvider.value = provider;
}
function backToPicker() {
	selectedProvider.value = null;
}

// Gmail maps to the 'google' backfill path; every other provider uses generic IMAP.
function sourceForProvider(provider: MailProvider): 'google' | 'imap' {
	return provider.id === 'gmail' ? 'google' : 'imap';
}

async function handleConnected() {
	const provider = selectedProvider.value;
	// The connect form only fires `submitted` for the picked provider, so this
	// should never be null — bail rather than silently defaulting a Gmail
	// connection down the generic-IMAP import path.
	if (!provider) return;
	const started = await start(sourceForProvider(provider));
	if (!started.ok) return;
	showToast(t('dashboard.postbox.migrate.toastImportStarted'), 'success');
}

// ── Ready step (already connected) ──────────────────────────────────────────
// Derive the provider from the connected account's IMAP host so the edit form
// keeps the right guidance; unknown hosts fall back to the generic IMAP form.
const connectedProvider = computed<MailProvider>(() =>
	providerForImapHost(account.value?.configured ? account.value.imapHost : null)
);
const connectedSource = computed<'google' | 'imap'>(() =>
	account.value?.configured && account.value.imapHost.includes('gmail') ? 'google' : 'imap'
);

// An import that finished while `ai.knowledge` was off (or whose sweep stored
// nothing) can still be learned from, without importing the mail again.
const canLearn = computed(() => canLearnFromImport(migration.value, isEnabled('ai.knowledge')));
async function handleLearn() {
	const res = await learn();
	if (res.ok) showToast(t('dashboard.postbox.migrate.toastLearnStarted'), 'success');
}
async function handleStartImport() {
	const res = await start(connectedSource.value);
	if (res.ok) showToast(t('dashboard.postbox.migrate.toastImportStarted'), 'success');
}

// ── Returning from Google sign-in ───────────────────────────────────────────
// The OAuth callback lands back on whatever page started the flow, flagged with
// `googleConnected=1`. The connect FORM cannot start the import itself — the
// browser left the page mid-flow and its `submitted` event never fired — so the
// wizard picks the thread back up here: strip the flag, then start the import
// once the account subscription reports the new mailbox.
const googleReturn = ref(route.query['googleConnected'] === '1');

onMounted(() => {
	if (!googleReturn.value) return;
	const query = { ...route.query };
	delete query['googleConnected'];
	void router.replace({ query });

	// `account` is a live subscription: with a warm cache it is already resolved
	// at mount, on a cold load it resolves a tick or two later. Register the
	// watcher FIRST and only then probe the current value — an `immediate: true`
	// watcher cannot call its own stop handle (the binding is still in its
	// temporal dead zone on the immediate run), which is a ReferenceError on
	// exactly the already-resolved path. `googleReturn` keeps this to one start.
	let stop: (() => void) | undefined;
	function startIfConnected() {
		if (!googleReturn.value || !account.value?.configured) return;
		googleReturn.value = false;
		stop?.();
		// An import already running (or finished) needs nothing started.
		if (migration.value) return;
		void handleStartImport();
	}
	stop = watch([account, migration], startIfConnected);
	startIfConnected();
});

// The connected account, or null: pre-fills the edit form and names the
// address on the ready and reconnect cards. It already carries every field the
// form's `account` prop needs (plus a few it ignores) and never includes the
// password — excess-property checks apply only to object literals, so passing
// the whole object through type-checks cleanly.
const editAccount = computed(() => (account.value?.configured ? account.value : null));

// ── Re-enter credentials (the reconnect step) ───────────────────────────────
// Everything else about managing the connection — changing the password from a
// healthy state, disconnecting, deleting — belongs to
// PostboxConnectedAccountCard, rendered below the wizard in every state, so it
// is reachable long after this wizard is done rather than only at `ready`.
function handleUpdated() {
	showToast(t('dashboard.postbox.migrate.toastCredentialsUpdated'), 'success');
}

// ── Completed step ──────────────────────────────────────────────────────────
// The mailbox the finished import landed in: PostboxMigrateCompletedStep saves
// the signature it detected in the imported Sent mail there.
const completedMailboxId = computed<Id<'mailboxes'> | null>(() =>
	step.value === 'completed' && account.value?.configured ? account.value.mailboxId : null
);
const signatureSaved = ref(false);

// ── Cancel migration ────────────────────────────────────────────────────────
const showCancel = ref(false);
async function handleCancel() {
	const cancelled = await cancel();
	showCancel.value = false;
	if (cancelled.ok) showToast(t('dashboard.postbox.migrate.toastCancelled'), 'success');
}

// ── Step indicator ──────────────────────────────────────────────────────────
const STEPS = [
	{ id: 'connect', labelKey: 'dashboard.postbox.migrate.steps.connect', number: 1 },
	{ id: 'import', labelKey: 'dashboard.postbox.migrate.steps.import', number: 2 },
	{ id: 'learn', labelKey: 'dashboard.postbox.migrate.steps.learn', number: 3 },
	{ id: 'done', labelKey: 'common.done', number: 4 },
];
const activeIndex = computed(() => {
	switch (step.value) {
		case 'importing':
			return 1;
		case 'indexing':
			return 2;
		case 'completed':
			return 3;
		default:
			return 0;
	}
});
function getStepStatus(stepId: string): 'completed' | 'current' | 'upcoming' {
	const idx = STEPS.findIndex((s) => s.id === stepId);
	if (idx < activeIndex.value) return 'completed';
	if (idx === activeIndex.value) return 'current';
	return 'upcoming';
}
function isConnectorHighlighted(index: number): boolean {
	return index < activeIndex.value;
}
const learnLabel = computed(() =>
	migration.value && !isAiIndexing.value
		? t('dashboard.postbox.migrate.steps.skipped')
		: t('dashboard.postbox.migrate.steps.learn')
);
const steps = computed(() =>
	STEPS.map(({ id, number, labelKey }) => ({
		id,
		number,
		label: id === 'learn' ? learnLabel.value : t(labelKey),
	}))
);
</script>

<template>
	<div class="p-6 lg:p-8 max-w-2xl mx-auto">
		<PreferencesBackLink />

		<UiPageHeader
			:title="t('dashboard.postbox.migrate.heading')"
			:description="t('dashboard.postbox.migrate.subheading')"
		/>

		<!-- Wait for the feature-flag subscription before deciding what to show,
		     so the lock card never flashes at users who have the feature on. -->
		<div v-if="flagsLoading" class="mt-8 flex justify-center py-10" aria-live="polite">
			<SpinnerIcon class="w-6 h-6 text-text-tertiary" />
			<span class="sr-only">{{ t('common.loading') }}</span>
		</div>

		<!-- ─────────────── Feature off: explain, don't vanish ─────────────── -->
		<UiCard v-else-if="!externalEnabled" padding="lg" class="mt-8">
			<div class="flex items-start gap-3">
				<UiIconBox :icon="LockIcon" size="md" variant="surface" rounded="xl" />
				<div>
					<h2 class="font-semibold">{{ t('dashboard.postbox.migrate.featureOffTitle') }}</h2>
					<p class="text-sm text-text-secondary mt-0.5">
						{{ t('dashboard.postbox.migrate.featureOffBody') }}
					</p>
				</div>
			</div>
		</UiCard>

		<template v-else>
			<UiStepIndicator
				class="my-8"
				:steps="steps"
				:get-step-status="getStepStatus"
				:is-connector-highlighted="isConnectorHighlighted"
			/>

			<p class="mb-5 text-sm text-text-secondary">
				{{
					t('dashboard.postbox.migrate.messageSizeLimit', {
						limit: MAIL_SYNC_MAX_RAW_MESSAGE_BYTES / (1024 * 1024),
					})
				}}
			</p>

			<!-- ───────────────────────── Connect ───────────────────────── -->
			<section v-if="step === 'connect'" class="space-y-5">
				<!-- Provider pick -->
				<div v-if="!selectedProvider">
					<h2 class="font-semibold mb-3">{{ t('dashboard.postbox.migrate.providerPickTitle') }}</h2>
					<div class="grid sm:grid-cols-2 gap-3">
						<button
							v-for="provider in MAIL_PROVIDERS"
							:key="provider.id"
							type="button"
							class="text-left rounded-xl border border-border-subtle bg-bg-surface p-4 hover:border-brand focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand transition-colors flex items-start gap-3"
							@click="pickProvider(provider)"
						>
							<UiIconBox :icon="provider.icon" size="md" variant="brand" rounded="xl" />
							<span>
								<span class="font-medium block">{{ t(provider.name) }}</span>
								<span class="text-xs text-text-tertiary">{{ t(provider.hint) }}</span>
							</span>
						</button>
					</div>
				</div>

				<!-- Connect form for the chosen provider -->
				<UiCard v-else padding="lg">
					<template #header>
						<div class="flex items-center gap-2">
							<UiIconBox :icon="selectedProvider.icon" size="sm" variant="brand" rounded="lg" />
							<h2 class="font-semibold">
								{{
									t('dashboard.postbox.migrate.connectProvider', {
										provider: t(selectedProvider.name),
									})
								}}
							</h2>
						</div>
					</template>
					<PostboxMailboxConnectForm
						:provider="selectedProvider"
						mode="connect"
						@submitted="handleConnected"
						@cancel="backToPicker"
					/>
				</UiCard>
			</section>

			<!-- ───────────────────────── Ready ───────────────────────── -->
			<section v-else-if="step === 'ready'" class="space-y-5">
				<UiCard padding="lg">
					<div class="flex items-start gap-3">
						<UiIconBox :icon="CircleCheckIcon" size="md" variant="success" rounded="xl" />
						<div>
							<p class="font-semibold">
								{{
									t('dashboard.postbox.migrate.readyTitle', {
										email: editAccount?.emailAddress ?? '',
									})
								}}
							</p>
							<p class="text-sm text-text-secondary mt-0.5">
								{{ t('dashboard.postbox.migrate.readyBody') }}
							</p>
						</div>
					</div>
					<ul class="mt-4 space-y-2 text-sm text-text-secondary">
						<li class="flex items-center gap-2">
							<DownloadIcon class="w-4 h-4 text-brand" />
							{{ t('dashboard.postbox.migrate.readyBulletImport') }}
						</li>
						<li class="flex items-center gap-2">
							<SparklesIcon class="w-4 h-4 text-brand" />
							{{
								isAiIndexing
									? t('dashboard.postbox.migrate.readyBulletAiOn')
									: t('dashboard.postbox.migrate.readyBulletAiOff')
							}}
						</li>
					</ul>
					<div class="mt-5 flex flex-wrap items-center gap-3">
						<UiButton variant="primary" :loading="startBusy" @click="handleStartImport">
							{{ t('dashboard.postbox.migrate.startImport') }}
						</UiButton>
					</div>
				</UiCard>
			</section>

			<!-- ───────────────────────── Reconnect ───────────────────────── -->
			<section v-else-if="step === 'reconnect'" class="space-y-5">
				<UiCard padding="lg" variant="error">
					<div class="flex items-start gap-3">
						<UiIconBox :icon="KeyIcon" size="md" variant="error" rounded="xl" />
						<div>
							<h2 class="font-semibold">
								{{
									t('dashboard.postbox.migrate.reconnectTitle', {
										email: editAccount?.emailAddress ?? '',
									})
								}}
							</h2>
							<p class="text-sm text-text-secondary mt-0.5">
								{{ editAccount?.lastError ?? t('dashboard.postbox.migrate.reconnectBody') }}
							</p>
						</div>
					</div>
				</UiCard>
				<UiCard padding="lg">
					<PostboxMailboxConnectForm
						:provider="connectedProvider"
						mode="update"
						:account="editAccount"
						hide-cancel
						@submitted="handleUpdated"
					/>
				</UiCard>
			</section>

			<!-- ─────────────── Importing / Indexing (Teaching AI) ─────────────── -->
			<PostboxMigrateProgressStep
				v-else-if="step === 'importing' || step === 'indexing'"
				:step="step"
				:migration="migration"
				:import-percent="importPercent"
				:index-percent="indexPercent"
				:is-discovering="isDiscovering"
				:is-paused="isPaused"
				:resumes-at-label="resumesAtLabel"
				@cancel="showCancel = true"
			/>

			<!-- ───────────────────────── Completed ───────────────────────── -->
			<PostboxMigrateCompletedStep
				v-else-if="step === 'completed'"
				:migration="migration"
				:is-ai-indexing="isAiIndexing"
				:can-learn="canLearn"
				:learn-busy="learnBusy"
				v-model:signature-saved="signatureSaved"
				:mailbox-id="completedMailboxId"
				@learn="handleLearn"
			/>

			<!-- ───────────────────────── Failed ───────────────────────── -->
			<section v-else-if="step === 'failed'" class="space-y-5">
				<UiCard padding="lg" variant="error">
					<div class="flex items-start gap-3">
						<UiIconBox :icon="TriangleWarningIcon" size="md" variant="error" rounded="xl" />
						<div>
							<h2 class="font-semibold">{{ t('dashboard.postbox.migrate.failedTitle') }}</h2>
							<p class="text-sm text-text-secondary mt-0.5">
								{{ failureMessage ?? t('dashboard.postbox.migrate.failedFallbackError') }}
							</p>
							<p class="text-sm text-text-secondary mt-1">
								{{ t('dashboard.postbox.migrate.failedBody') }}
							</p>
						</div>
					</div>
					<div class="mt-5">
						<UiButton variant="primary" :loading="startBusy" @click="handleStartImport">
							{{ t('dashboard.postbox.migrate.tryAgain') }}
						</UiButton>
					</div>
				</UiCard>
			</section>

			<!-- ───────────────────────── Cancelled ───────────────────────── -->
			<section v-else-if="step === 'cancelled'" class="space-y-5">
				<UiCard padding="lg">
					<div class="flex items-start gap-3">
						<UiIconBox :icon="CircleSlashIcon" size="md" variant="surface" rounded="xl" />
						<div>
							<h2 class="font-semibold">{{ t('dashboard.postbox.migrate.cancelledTitle') }}</h2>
							<p class="text-sm text-text-secondary mt-0.5">
								{{ t('dashboard.postbox.migrate.cancelledBody') }}
							</p>
						</div>
					</div>
					<div class="mt-5">
						<UiButton variant="primary" :loading="startBusy" @click="handleStartImport">
							{{ t('dashboard.postbox.migrate.startAgain') }}
						</UiButton>
					</div>
				</UiCard>
			</section>
		</template>

		<!--
			The connection itself: its state, changing the password, disconnecting,
			deleting. Inside the feature gate (there is no connection to manage
			without it) but outside the step branches, because ending a connection
			has to stay reachable in every one of them — including long after the
			import has finished, which is where this used to disappear.
		-->
		<PostboxConnectedAccountCard
			v-if="externalEnabled && !flagsLoading"
			class="mt-8"
			:show-empty-state="false"
			:show-credential-update="step !== 'reconnect'"
		/>

		<!--
			Import from a file. Outside the feature gate above on purpose: the IMAP
			half of this wizard needs `mail.external`, but taking someone's Takeout
			archive needs nothing but a mailbox to put it in — and the people with
			only a file are exactly the ones who cannot connect an account.
		-->
		<PostboxArchiveImportCard v-if="!flagsLoading" class="mt-8" />

		<!-- Cancel confirm -->
		<UiConfirmationDialog
			:open="showCancel"
			:title="t('dashboard.postbox.migrate.cancelDialogTitle')"
			:description="t('dashboard.postbox.migrate.cancelDialogDescription')"
			:confirm-text="t('dashboard.postbox.migrate.cancelMigration')"
			variant="warning"
			:is-loading="cancelBusy"
			@confirm="handleCancel"
			@cancel="showCancel = false"
			@update:open="showCancel = $event"
		/>
	</div>
</template>
