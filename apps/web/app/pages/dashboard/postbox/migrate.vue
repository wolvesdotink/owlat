<script setup lang="ts">
import type { MailProvider } from '~/utils/mailAutodiscover';
import { GENERIC_IMAP_PROVIDER, MAIL_PROVIDERS } from '~/utils/mailAutodiscover';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.postbox.migrate.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

/** Counts read as body copy, so they follow the active locale's grouping. */
function formatCount(value: number | undefined): string {
	return new Intl.NumberFormat(locale.value).format(value ?? 0);
}

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
	start,
	cancel,
	startBusy,
	cancelBusy,
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
const connectedProvider = computed<MailProvider>(() => {
	const host = account.value?.configured ? account.value.imapHost.toLowerCase() : '';
	const match = MAIL_PROVIDERS.find((p) => p.preset && host === p.preset.imapHost.toLowerCase());
	return match ?? GENERIC_IMAP_PROVIDER;
});
const connectedSource = computed<'google' | 'imap'>(() =>
	account.value?.configured && account.value.imapHost.includes('gmail') ? 'google' : 'imap'
);
async function handleStartImport() {
	const res = await start(connectedSource.value);
	if (res.ok) showToast(t('dashboard.postbox.migrate.toastImportStarted'), 'success');
}

// The existing account, for pre-filling the edit form. The connected account
// already carries every field the form's `account` prop needs (plus a few it
// ignores) and never includes the password — excess-property checks apply only
// to object literals, so passing the whole object through type-checks cleanly.
const editAccount = computed(() => (account.value?.configured ? account.value : null));

// ── Manage: edit credentials / disconnect / purge ───────────────────────────
const editing = ref(false);
function handleUpdated() {
	editing.value = false;
	showToast(t('dashboard.postbox.migrate.toastCredentialsUpdated'), 'success');
}

const disconnectOp = useBackendOperation(api.mail.external.accounts.disconnect, {
	label: () => t('dashboard.postbox.migrate.disconnectOperation'),
});
const purgeOp = useBackendOperation(api.mail.external.accounts.purge, {
	label: () => t('dashboard.postbox.migrate.purgeOperation'),
});
const showDisconnect = ref(false);
const showPurge = ref(false);
async function handleDisconnect() {
	const res = await disconnectOp.run({});
	showDisconnect.value = false;
	if (res.ok) showToast(t('dashboard.postbox.migrate.toastDisconnected'), 'success');
}
async function handlePurge() {
	const res = await purgeOp.run({});
	showPurge.value = false;
	if (res.ok) showToast(t('dashboard.postbox.migrate.toastPurging'), 'success');
}

// ── Detected signature (completion nice-touch) ──────────────────────────────
// After the import finishes we scan the imported Sent mail for a repeated
// trailing block and offer it pre-filled, so replies look like they did before.
const completedMailboxId = computed<Id<'mailboxes'> | null>(() =>
	step.value === 'completed' && account.value?.configured ? account.value.mailboxId : null
);
const { data: suggestedSignature } = useConvexQuery(api.mail.signatures.suggestFromImport, () =>
	completedMailboxId.value ? { mailboxId: completedMailboxId.value } : 'skip'
);
const createSignatureOp = useBackendOperation(api.mail.signatures.create, {
	label: () => t('dashboard.postbox.migrate.saveSignatureOperation'),
});
const signatureSaved = ref(false);
function detectedSignatureHtml(text: string): string {
	const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	return `<div>${escaped.replace(/\n/g, '<br>')}</div>`;
}
async function saveDetectedSignature() {
	const mailboxId = completedMailboxId.value;
	const text = suggestedSignature.value;
	if (!mailboxId || !text) return;
	const res = await createSignatureOp.run({
		mailboxId,
		name: t('dashboard.postbox.migrate.importedSignatureName'),
		html: detectedSignatureHtml(text),
		isDefault: true,
	});
	if (res.ok) {
		signatureSaved.value = true;
		showToast(t('dashboard.postbox.migrate.toastSignatureSaved'), 'success');
	}
}

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

		<header class="flex items-center gap-3">
			<UiIconBox icon="lucide:mail" size="lg" variant="brand" rounded="2xl" />
			<div>
				<h1 class="text-2xl font-medium tracking-[-0.02em]">
					{{ t('dashboard.postbox.migrate.heading') }}
				</h1>
				<p class="text-text-secondary text-sm mt-0.5">
					{{ t('dashboard.postbox.migrate.subheading') }}
				</p>
			</div>
		</header>

		<!-- Wait for the feature-flag subscription before deciding what to show,
		     so the lock card never flashes at users who have the feature on. -->
		<div v-if="flagsLoading" class="mt-8 flex justify-center py-10" aria-live="polite">
			<Icon name="lucide:loader-2" class="w-6 h-6 animate-spin motion-reduce:animate-none text-text-tertiary" />
			<span class="sr-only">{{ t('common.loading') }}</span>
		</div>

		<!-- ─────────────── Feature off: explain, don't vanish ─────────────── -->
		<UiCard v-else-if="!externalEnabled" padding="lg" class="mt-8">
			<div class="flex items-start gap-3">
				<UiIconBox icon="lucide:lock" size="md" variant="surface" rounded="xl" />
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
				<UiCard v-if="!editing" padding="lg">
					<div class="flex items-start gap-3">
						<UiIconBox icon="lucide:check-circle-2" size="md" variant="success" rounded="xl" />
						<div>
							<p class="font-semibold">
								{{
									t('dashboard.postbox.migrate.readyTitle', { email: account?.emailAddress ?? '' })
								}}
							</p>
							<p class="text-sm text-text-secondary mt-0.5">
								{{ t('dashboard.postbox.migrate.readyBody') }}
							</p>
						</div>
					</div>
					<ul class="mt-4 space-y-2 text-sm text-text-secondary">
						<li class="flex items-center gap-2">
							<Icon name="lucide:download" class="w-4 h-4 text-brand" />
							{{ t('dashboard.postbox.migrate.readyBulletImport') }}
						</li>
						<li class="flex items-center gap-2">
							<Icon name="lucide:sparkles" class="w-4 h-4 text-brand" />
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
						<UiButton variant="ghost" @click="editing = true">
							{{ t('dashboard.postbox.migrate.updateCredentials') }}
						</UiButton>
						<UiButton variant="ghost" class="text-error" @click="showDisconnect = true">
							{{ t('dashboard.postbox.migrate.disconnect') }}
						</UiButton>
						<UiButton variant="ghost" class="text-error" @click="showPurge = true">
							{{ t('dashboard.postbox.migrate.deleteMailboxAndData') }}
						</UiButton>
					</div>
				</UiCard>

				<!-- Edit credentials -->
				<UiCard v-else padding="lg">
					<template #header>
						<h2 class="font-semibold">
							{{
								t('dashboard.postbox.migrate.updateCredentialsTitle', {
									email: account?.emailAddress ?? '',
								})
							}}
						</h2>
					</template>
					<PostboxMailboxConnectForm
						:provider="connectedProvider"
						mode="update"
						:account="editAccount"
						@submitted="handleUpdated"
						@cancel="editing = false"
					/>
				</UiCard>
			</section>

			<!-- ───────────────────────── Reconnect ───────────────────────── -->
			<section v-else-if="step === 'reconnect'" class="space-y-5">
				<UiCard padding="lg" variant="error">
					<div class="flex items-start gap-3">
						<UiIconBox icon="lucide:key-round" size="md" variant="error" rounded="xl" />
						<div>
							<h2 class="font-semibold">
								{{
									t('dashboard.postbox.migrate.reconnectTitle', {
										email: account?.emailAddress ?? '',
									})
								}}
							</h2>
							<p class="text-sm text-text-secondary mt-0.5">
								{{ account?.lastError ?? t('dashboard.postbox.migrate.reconnectBody') }}
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

			<!-- ───────────────────────── Importing ───────────────────────── -->
			<section v-else-if="step === 'importing'" class="space-y-5">
				<UiCard padding="lg">
					<div class="flex items-center gap-3">
						<UiIconBox icon="lucide:download-cloud" size="md" variant="brand" rounded="xl" />
						<div>
							<h2 class="font-semibold">
								{{
									isDiscovering
										? t('dashboard.postbox.migrate.discoveringTitle')
										: t('dashboard.postbox.migrate.importingTitle')
								}}
							</h2>
							<p class="text-sm text-text-secondary">
								{{ t('dashboard.postbox.migrate.importingBody') }}
							</p>
						</div>
					</div>

					<div class="mt-5 space-y-2">
						<UiProgressBar
							:value="importPercent"
							:indeterminate="isDiscovering"
							:aria-label="
								isDiscovering
									? t('dashboard.postbox.migrate.discoveringProgressLabel')
									: t('dashboard.postbox.migrate.importProgressLabel')
							"
						/>
						<div class="flex justify-between text-xs text-text-tertiary">
							<span v-if="isDiscovering">{{
								t('dashboard.postbox.migrate.discoveringFolders')
							}}</span>
							<span v-else>
								{{
									t('dashboard.postbox.migrate.importCount', {
										imported: formatCount(migration?.messagesImported),
										total: formatCount(migration?.messagesTotal),
									})
								}}
							</span>
							<span v-if="!isDiscovering">{{ importPercent }}%</span>
						</div>
					</div>

					<div class="mt-5">
						<UiButton variant="danger-ghost" size="sm" @click="showCancel = true">
							{{ t('dashboard.postbox.migrate.cancelMigration') }}
						</UiButton>
					</div>
				</UiCard>
			</section>

			<!-- ───────────────────────── Indexing (Teaching AI) ───────────────────────── -->
			<section v-else-if="step === 'indexing'" class="space-y-5">
				<UiCard padding="lg">
					<div class="flex items-center gap-3">
						<UiIconBox icon="lucide:sparkles" size="md" variant="success" rounded="xl" />
						<div>
							<h2 class="font-semibold">{{ t('dashboard.postbox.migrate.indexingTitle') }}</h2>
							<p class="text-sm text-text-secondary">
								{{ t('dashboard.postbox.migrate.indexingBody') }}
							</p>
						</div>
					</div>

					<div class="mt-5 space-y-2">
						<UiProgressBar
							:value="indexPercent"
							variant="success"
							:aria-label="t('dashboard.postbox.migrate.indexProgressLabel')"
						/>
						<div class="flex justify-between text-xs text-text-tertiary">
							<span>
								{{
									t('dashboard.postbox.migrate.indexCount', {
										indexed: formatCount(migration?.messagesIndexed),
										imported: formatCount(migration?.messagesImported),
									})
								}}
							</span>
							<span>{{ indexPercent }}%</span>
						</div>
					</div>

					<p class="mt-4 text-xs text-text-tertiary">
						{{ t('dashboard.postbox.migrate.indexingFootnote') }}
					</p>
				</UiCard>
			</section>

			<!-- ───────────────────────── Completed ───────────────────────── -->
			<section v-else-if="step === 'completed'" class="space-y-5">
				<UiCard padding="lg">
					<div class="text-center py-2">
						<UiIconBox
							icon="lucide:party-popper"
							size="xl"
							variant="success"
							rounded="2xl"
							class="mx-auto"
						/>
						<h2 class="text-xl font-semibold mt-4">
							{{ t('dashboard.postbox.migrate.completedTitle') }}
						</h2>
						<p class="text-text-secondary mt-1">
							{{
								isAiIndexing
									? t('dashboard.postbox.migrate.completedBodyWithAi')
									: t('dashboard.postbox.migrate.completedBody')
							}}
						</p>

						<div class="grid grid-cols-2 gap-3 mt-6 text-left">
							<div class="rounded-xl bg-text-tertiary/5 p-4">
								<p class="text-2xl font-medium tracking-[-0.02em]">
									{{ formatCount(migration?.messagesImported) }}
								</p>
								<p class="text-xs text-text-tertiary mt-0.5">
									{{ t('dashboard.postbox.migrate.statMessagesImported') }}
								</p>
							</div>
							<div v-if="isAiIndexing" class="rounded-xl bg-text-tertiary/5 p-4">
								<p class="text-2xl font-medium tracking-[-0.02em]">
									{{ formatCount(migration?.messagesIndexed) }}
								</p>
								<p class="text-xs text-text-tertiary mt-0.5">
									{{ t('dashboard.postbox.migrate.statConversationsLearned') }}
								</p>
							</div>
						</div>

						<div class="flex flex-col sm:flex-row gap-3 justify-center mt-7">
							<UiButton variant="primary" @click="navigateTo('/dashboard/postbox/inbox')">
								{{ t('dashboard.postbox.migrate.openInbox') }}
							</UiButton>
							<UiButton
								v-if="isAiIndexing"
								variant="secondary"
								@click="navigateTo('/dashboard/knowledge')"
							>
								{{ t('dashboard.postbox.migrate.seeWhatAiLearned') }}
							</UiButton>
						</div>

						<!-- Detected signature: offer the block we found in imported sent mail. -->
						<div
							v-if="suggestedSignature && !signatureSaved"
							class="mt-7 text-left rounded-xl border border-border-subtle bg-bg-surface p-4"
						>
							<p class="text-sm font-medium">
								{{ t('dashboard.postbox.migrate.signatureFoundTitle') }}
							</p>
							<p class="text-xs text-text-tertiary mt-0.5">
								{{ t('dashboard.postbox.migrate.signatureFoundBody') }}
							</p>
							<pre
								class="mt-3 text-xs text-text-secondary whitespace-pre-wrap font-sans bg-text-tertiary/5 rounded-lg p-3"
								>{{ suggestedSignature }}</pre>
							<div class="mt-3 flex items-center gap-3">
								<UiButton
									size="sm"
									variant="secondary"
									:loading="createSignatureOp.isLoading.value"
									@click="saveDetectedSignature"
								>
									{{ t('dashboard.postbox.migrate.useThisSignature') }}
								</UiButton>
								<NuxtLink
									to="/dashboard/preferences/signatures"
									class="text-xs text-text-tertiary hover:text-text-primary"
								>
									{{ t('dashboard.postbox.migrate.editSignatureFirst') }}
								</NuxtLink>
							</div>
						</div>
						<p
							v-else-if="signatureSaved"
							class="text-xs text-success mt-6 inline-flex items-center gap-1"
						>
							<Icon name="lucide:check" class="w-3.5 h-3.5" />
							{{ t('dashboard.postbox.migrate.signatureSaved') }}
						</p>
						<I18nT
							v-else
							keypath="dashboard.postbox.migrate.signatureTip"
							tag="p"
							scope="global"
							class="text-xs text-text-tertiary mt-6"
						>
							<template #link>
								<NuxtLink to="/dashboard/preferences/signatures" class="text-brand hover:underline">
									{{ t('dashboard.postbox.migrate.signatureTipLink') }}
								</NuxtLink>
							</template>
						</I18nT>
					</div>
				</UiCard>
			</section>

			<!-- ───────────────────────── Failed ───────────────────────── -->
			<section v-else-if="step === 'failed'" class="space-y-5">
				<UiCard padding="lg" variant="error">
					<div class="flex items-start gap-3">
						<UiIconBox icon="lucide:alert-triangle" size="md" variant="error" rounded="xl" />
						<div>
							<h2 class="font-semibold">{{ t('dashboard.postbox.migrate.failedTitle') }}</h2>
							<p class="text-sm text-text-secondary mt-0.5">
								{{ migration?.lastError ?? t('dashboard.postbox.migrate.failedFallbackError') }}
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
						<UiIconBox icon="lucide:circle-slash" size="md" variant="surface" rounded="xl" />
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

		<!-- Disconnect confirm -->
		<UiConfirmationDialog
			:open="showDisconnect"
			:title="t('dashboard.postbox.migrate.disconnectDialogTitle')"
			:description="t('dashboard.postbox.migrate.disconnectDialogDescription')"
			:confirm-text="t('dashboard.postbox.migrate.disconnect')"
			variant="warning"
			:is-loading="disconnectOp.isLoading.value"
			@confirm="handleDisconnect"
			@cancel="showDisconnect = false"
			@update:open="showDisconnect = $event"
		/>

		<!-- Purge confirm -->
		<UiConfirmationDialog
			:open="showPurge"
			:title="t('dashboard.postbox.migrate.purgeDialogTitle')"
			:description="t('dashboard.postbox.migrate.purgeDialogDescription')"
			:confirm-text="t('dashboard.postbox.migrate.purgeConfirm')"
			variant="danger"
			:is-loading="purgeOp.isLoading.value"
			@confirm="handlePurge"
			@cancel="showPurge = false"
			@update:open="showPurge = $event"
		/>
	</div>
</template>
