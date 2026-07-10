<script setup lang="ts">
import type { MailProvider } from '~/utils/mailAutodiscover';
import { MAIL_PROVIDERS, providerById } from '~/utils/mailAutodiscover';
import { api } from '@owlat/api';

useHead({ title: 'Import your mail — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const { showToast } = useToast();
const { isEnabled } = useFeatureFlag();
// Gate inline rather than via requiresAnyFeature: when external mailboxes are
// turned off the wizard explains itself instead of silently redirecting away.
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
function sourceForProvider(provider: MailProvider | null): 'google' | 'imap' {
	return provider?.id === 'gmail' ? 'google' : 'imap';
}

async function handleConnected() {
	const provider = selectedProvider.value;
	const started = await start(sourceForProvider(provider));
	if (started === undefined) return;
	showToast('Importing your mail history now.', 'success');
}

// ── Ready step (already connected) ──────────────────────────────────────────
// Derive the provider from the connected account's IMAP host so the edit form
// keeps the right guidance; unknown hosts fall back to the generic IMAP form.
// The generic IMAP provider always exists in the curated list.
const genericImapProvider = providerById('imap') as MailProvider;
const connectedProvider = computed<MailProvider>(() => {
	const host = account.value?.configured ? account.value.imapHost.toLowerCase() : '';
	const match = MAIL_PROVIDERS.find((p) => p.preset && host === p.preset.imapHost.toLowerCase());
	return match ?? genericImapProvider;
});
const connectedSource = computed<'google' | 'imap'>(() =>
	account.value?.configured && account.value.imapHost.includes('gmail') ? 'google' : 'imap'
);
async function handleStartImport() {
	const res = await start(connectedSource.value);
	if (res !== undefined) showToast('Importing your mail history now.', 'success');
}

// The existing account, shaped for the edit form (never carries the password).
const editAccount = computed(() =>
	account.value?.configured
		? {
				emailAddress: account.value.emailAddress,
				imapHost: account.value.imapHost,
				imapPort: account.value.imapPort,
				isImapSecure: account.value.isImapSecure,
				smtpHost: account.value.smtpHost,
				smtpPort: account.value.smtpPort,
				isSmtpSecure: account.value.isSmtpSecure,
				imapUsername: account.value.imapUsername,
				status: account.value.status,
			}
		: null
);

// ── Manage: edit credentials / disconnect / purge ───────────────────────────
const editing = ref(false);
function handleUpdated() {
	editing.value = false;
	showToast('Credentials updated.', 'success');
}

const disconnectOp = useBackendOperation(api.mail.externalAccounts.disconnect, {
	label: 'Disconnect mailbox',
});
const purgeOp = useBackendOperation(api.mail.externalAccounts.purge, {
	label: 'Delete mailbox and synced data',
});
const showDisconnect = ref(false);
const showPurge = ref(false);
async function handleDisconnect() {
	const res = await disconnectOp.run({});
	showDisconnect.value = false;
	if (res !== undefined) showToast('Mailbox disconnected.', 'success');
}
async function handlePurge() {
	const res = await purgeOp.run({});
	showPurge.value = false;
	if (res !== undefined) showToast('Mailbox and all synced data are being deleted.', 'success');
}

// ── Cancel migration ────────────────────────────────────────────────────────
const showCancel = ref(false);
async function handleCancel() {
	const ok = await cancel();
	showCancel.value = false;
	if (ok) showToast('Migration cancelled. Imported mail was kept.', 'success');
}

// ── Step indicator ──────────────────────────────────────────────────────────
const STEPS = [
	{ id: 'connect', label: 'Connect', number: 1 },
	{ id: 'import', label: 'Import mail', number: 2 },
	{ id: 'learn', label: 'Teach AI', number: 3 },
	{ id: 'done', label: 'Done', number: 4 },
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
	migration.value && !isAiIndexing.value ? 'Skipped' : 'Teach AI'
);
const steps = computed(() =>
	STEPS.map((s) => (s.id === 'learn' ? { ...s, label: learnLabel.value } : s))
);
</script>

<template>
	<div class="p-6 lg:p-8 max-w-2xl mx-auto">
		<NuxtLink
			to="/dashboard/postbox/settings"
			class="text-sm text-text-secondary inline-flex items-center gap-1 hover:text-text-primary mb-4"
		>
			<Icon name="lucide:arrow-left" class="w-3.5 h-3.5" />
			Back to settings
		</NuxtLink>

		<header class="flex items-center gap-3">
			<UiIconBox icon="lucide:mail" size="lg" variant="brand" rounded="2xl" />
			<div>
				<h1 class="text-2xl font-semibold">Import your mail</h1>
				<p class="text-text-secondary text-sm mt-0.5">
					Bring your existing mailbox into Owlat — and let your AI assistant learn from it.
				</p>
			</div>
		</header>

		<!-- ─────────────── Feature off: explain, don't vanish ─────────────── -->
		<UiCard v-if="!externalEnabled" padding="lg" class="mt-8">
			<div class="flex items-start gap-3">
				<UiIconBox icon="lucide:lock" size="md" variant="surface" rounded="xl" />
				<div>
					<h2 class="font-semibold">External mailboxes are turned off</h2>
					<p class="text-sm text-text-secondary mt-0.5">
						Importing from another mailbox needs the external-accounts feature. Ask your Owlat admin
						to enable it, then come back here to bring your mail in.
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
					<h2 class="font-semibold mb-3">Where does your mail live now?</h2>
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
								<span class="font-medium block">{{ provider.name }}</span>
								<span class="text-xs text-text-tertiary">{{ provider.hint }}</span>
							</span>
						</button>
					</div>
				</div>

				<!-- Connect form for the chosen provider -->
				<UiCard v-else padding="lg">
					<template #header>
						<div class="flex items-center gap-2">
							<UiIconBox :icon="selectedProvider.icon" size="sm" variant="brand" rounded="lg" />
							<h2 class="font-semibold">Connect {{ selectedProvider.name }}</h2>
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
							<p class="font-semibold">{{ account?.emailAddress }} is connected</p>
							<p class="text-sm text-text-secondary mt-0.5">
								We'll import your entire mail history — Inbox, Sent, and all your archived mail.
							</p>
						</div>
					</div>
					<ul class="mt-4 space-y-2 text-sm text-text-secondary">
						<li class="flex items-center gap-2">
							<Icon name="lucide:download" class="w-4 h-4 text-brand" />
							Your old messages are imported into your Owlat inbox.
						</li>
						<li class="flex items-center gap-2">
							<Icon name="lucide:sparkles" class="w-4 h-4 text-brand" />
							{{
								isAiIndexing
									? 'Your AI assistant learns from each conversation, scoped per contact.'
									: 'Enable the AI knowledge feature first to let the assistant learn from your mail.'
							}}
						</li>
					</ul>
					<div class="mt-5 flex flex-wrap items-center gap-3">
						<UiButton variant="primary" :loading="startBusy" @click="handleStartImport">
							Start import
						</UiButton>
						<UiButton variant="ghost" @click="editing = true">Update credentials</UiButton>
						<UiButton variant="ghost" class="text-error" @click="showDisconnect = true">
							Disconnect
						</UiButton>
						<UiButton variant="ghost" class="text-error" @click="showPurge = true">
							Delete mailbox & data
						</UiButton>
					</div>
				</UiCard>

				<!-- Edit credentials -->
				<UiCard v-else padding="lg">
					<template #header>
						<h2 class="font-semibold">Update {{ account?.emailAddress }} credentials</h2>
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
							<h2 class="font-semibold">Reconnect {{ account?.emailAddress }} first</h2>
							<p class="text-sm text-text-secondary mt-0.5">
								{{
									account?.lastError ??
									"Your mailbox credentials aren't working. Update your password below before importing — otherwise the import can't connect."
								}}
							</p>
						</div>
					</div>
				</UiCard>
				<UiCard padding="lg">
					<PostboxMailboxConnectForm
						:provider="connectedProvider"
						mode="update"
						:account="editAccount"
						@submitted="handleUpdated"
						@cancel="editing = false"
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
								{{ isDiscovering ? 'Discovering your mailbox…' : 'Importing your mail history' }}
							</h2>
							<p class="text-sm text-text-secondary">
								You can leave this page — the import keeps running in the background.
							</p>
						</div>
					</div>

					<div class="mt-5 space-y-2">
						<UiProgressBar
							:value="importPercent"
							:indeterminate="isDiscovering"
							:aria-label="isDiscovering ? 'Discovering mailbox' : 'Import progress'"
						/>
						<div class="flex justify-between text-xs text-text-tertiary">
							<span v-if="isDiscovering">Looking at your folders…</span>
							<span v-else>
								{{ migration?.messagesImported?.toLocaleString() }} of
								{{ migration?.messagesTotal?.toLocaleString() }} messages
							</span>
							<span v-if="!isDiscovering">{{ importPercent }}%</span>
						</div>
					</div>

					<div class="mt-5">
						<UiButton variant="danger-ghost" size="sm" @click="showCancel = true">
							Cancel migration
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
							<h2 class="font-semibold">Teaching your AI assistant</h2>
							<p class="text-sm text-text-secondary">
								Reading through your imported mail to learn about your contacts and conversations.
							</p>
						</div>
					</div>

					<div class="mt-5 space-y-2">
						<UiProgressBar
							:value="indexPercent"
							variant="success"
							aria-label="AI learning progress"
						/>
						<div class="flex justify-between text-xs text-text-tertiary">
							<span>
								Learned from {{ migration?.messagesIndexed?.toLocaleString() }} of
								{{ migration?.messagesImported?.toLocaleString() }} messages
							</span>
							<span>{{ indexPercent }}%</span>
						</div>
					</div>

					<p class="mt-4 text-xs text-text-tertiary">
						Your mail is already in your inbox — this last step just makes the AI smarter.
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
						<h2 class="text-xl font-semibold mt-4">You're all moved in</h2>
						<p class="text-text-secondary mt-1">
							Your mail history is in Owlat{{
								isAiIndexing ? ' and your AI assistant has learned from it.' : '.'
							}}
						</p>

						<div class="grid grid-cols-2 gap-3 mt-6 text-left">
							<div class="rounded-xl bg-text-tertiary/5 p-4">
								<p class="text-2xl font-semibold">
									{{ migration?.messagesImported?.toLocaleString() ?? 0 }}
								</p>
								<p class="text-xs text-text-tertiary mt-0.5">messages imported</p>
							</div>
							<div v-if="isAiIndexing" class="rounded-xl bg-text-tertiary/5 p-4">
								<p class="text-2xl font-semibold">
									{{ migration?.messagesIndexed?.toLocaleString() ?? 0 }}
								</p>
								<p class="text-xs text-text-tertiary mt-0.5">conversations learned</p>
							</div>
						</div>

						<div class="flex flex-col sm:flex-row gap-3 justify-center mt-7">
							<UiButton variant="primary" @click="navigateTo('/dashboard/postbox/inbox')">
								Open your inbox
							</UiButton>
							<UiButton
								v-if="isAiIndexing"
								variant="secondary"
								@click="navigateTo('/dashboard/knowledge')"
							>
								See what your AI learned
							</UiButton>
						</div>

						<p class="text-xs text-text-tertiary mt-6">
							Tip: check your
							<NuxtLink
								to="/dashboard/postbox/settings/signatures"
								class="text-brand hover:underline"
							>
								email signature
							</NuxtLink>
							so your replies look just like they did before.
						</p>
					</div>
				</UiCard>
			</section>

			<!-- ───────────────────────── Failed ───────────────────────── -->
			<section v-else-if="step === 'failed'" class="space-y-5">
				<UiCard padding="lg" variant="error">
					<div class="flex items-start gap-3">
						<UiIconBox icon="lucide:alert-triangle" size="md" variant="error" rounded="xl" />
						<div>
							<h2 class="font-semibold">Migration ran into a problem</h2>
							<p class="text-sm text-text-secondary mt-0.5">
								{{ migration?.lastError ?? 'Something went wrong while importing your mail.' }}
							</p>
							<p class="text-sm text-text-secondary mt-1">
								Any mail imported so far was kept. You can try again.
							</p>
						</div>
					</div>
					<div class="mt-5">
						<UiButton variant="primary" :loading="startBusy" @click="handleStartImport">
							Try again
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
							<h2 class="font-semibold">Migration cancelled</h2>
							<p class="text-sm text-text-secondary mt-0.5">
								The mail imported before you cancelled is still in your inbox.
							</p>
						</div>
					</div>
					<div class="mt-5">
						<UiButton variant="primary" :loading="startBusy" @click="handleStartImport">
							Start again
						</UiButton>
					</div>
				</UiCard>
			</section>
		</template>

		<!-- Cancel confirm -->
		<UiConfirmationDialog
			:open="showCancel"
			title="Cancel the migration?"
			description="Mail imported so far is kept. The rest of your history won't be imported unless you start again."
			confirm-text="Cancel migration"
			variant="warning"
			:is-loading="cancelBusy"
			@confirm="handleCancel"
			@cancel="showCancel = false"
			@update:open="showCancel = $event"
		/>

		<!-- Disconnect confirm -->
		<UiConfirmationDialog
			:open="showDisconnect"
			title="Disconnect this mailbox?"
			description="Syncing stops and it's hidden from your inbox. Synced messages are kept unless you delete them separately."
			confirm-text="Disconnect"
			variant="warning"
			:is-loading="disconnectOp.isLoading.value"
			@confirm="handleDisconnect"
			@cancel="showDisconnect = false"
			@update:open="showDisconnect = $event"
		/>

		<!-- Purge confirm -->
		<UiConfirmationDialog
			:open="showPurge"
			title="Delete mailbox and all synced data?"
			description="Every imported message, draft, folder and label is erased and cannot be recovered. Use this if you connected the wrong mailbox or want your imported mail genuinely removed."
			confirm-text="Delete everything"
			variant="danger"
			:is-loading="purgeOp.isLoading.value"
			@confirm="handlePurge"
			@cancel="showPurge = false"
			@update:open="showPurge = $event"
		/>
	</div>
</template>
