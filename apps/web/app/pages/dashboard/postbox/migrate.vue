<script setup lang="ts">
import { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';

useHead({ title: 'Migrate from Google — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['mail.external'],
});

const { showToast } = useToast();
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

// ── Connect step (Gmail-guided) ─────────────────────────────────────────────
// The wizard targets Gmail; other IMAP providers use the generic connector.
const GMAIL = {
	imapHost: 'imap.gmail.com',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.gmail.com',
	smtpPort: 465,
	isSmtpSecure: true,
};

const form = reactive({ emailAddress: '', password: '' });
const formError = ref<string | null>(null);
// Derived from the action's return type so the test-result shape can't drift.
type TestResult = FunctionReturnType<typeof api.mail.externalAccountsActions.testConnection>;
const testResult = ref<TestResult | null>(null);

const testOp = useBackendOperation(api.mail.externalAccountsActions.testConnection, {
	type: 'action',
	label: 'Test Gmail connection',
	inlineTarget: formError,
});
const connectOp = useBackendOperation(api.mail.externalAccountsActions.connect, {
	type: 'action',
	label: 'Connect Gmail',
	inlineTarget: formError,
});

function buildArgs() {
	const email = form.emailAddress.trim();
	return {
		emailAddress: email,
		imapHost: GMAIL.imapHost,
		imapPort: GMAIL.imapPort,
		isImapSecure: GMAIL.isImapSecure,
		smtpHost: GMAIL.smtpHost,
		smtpPort: GMAIL.smtpPort,
		isSmtpSecure: GMAIL.isSmtpSecure,
		username: email,
		password: form.password,
	};
}

const canSubmit = computed(
	() => /^.+@.+\..+$/.test(form.emailAddress.trim()) && form.password.trim().length > 0,
);
const connectBusy = computed(() => testOp.isLoading.value || connectOp.isLoading.value);

async function handleTest() {
	testResult.value = null;
	const res = await testOp.run(buildArgs());
	if (res) testResult.value = res;
}

async function handleConnectAndImport() {
	const connected = await connectOp.run(buildArgs());
	if (connected === undefined) return;
	form.password = '';
	const started = await start('google');
	// start() failed — its own error toast already fired and the wizard falls back
	// to the "ready" step for a retry. Don't claim success on top of that.
	if (started === undefined) return;
	showToast('Importing your Gmail history now.', 'success');
}

// ── Ready step (already connected) ──────────────────────────────────────────
const connectedSource = computed<'google' | 'imap'>(() =>
	account.value?.configured && account.value.imapHost?.includes('gmail') ? 'google' : 'imap',
);
async function handleStartImport() {
	const res = await start(connectedSource.value);
	if (res !== undefined) showToast('Importing your mail history now.', 'success');
}

// ── Cancel ──────────────────────────────────────────────────────────────────
const showCancel = ref(false);
async function handleCancel() {
	const ok = await cancel();
	showCancel.value = false;
	// Only confirm when something was actually cancelled (false = nothing active,
	// undefined = the call failed and already surfaced its own error toast).
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
			return 0; // connect / ready / failed / cancelled
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

// The "Teach AI" step is skipped entirely when AI indexing is off — reflect
// that in the indicator copy so it doesn't look stuck.
const learnLabel = computed(() =>
	migration.value && !isAiIndexing.value ? 'Skipped' : 'Teach AI',
);
const steps = computed(() =>
	STEPS.map((s) => (s.id === 'learn' ? { ...s, label: learnLabel.value } : s)),
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
				<h1 class="text-2xl font-semibold">Migrate from Google</h1>
				<p class="text-text-secondary text-sm mt-0.5">
					Bring your Gmail history into Owlat — and let your AI assistant learn from it.
				</p>
			</div>
		</header>

		<UiStepIndicator
			class="my-8"
			:steps="steps"
			:get-step-status="getStepStatus"
			:is-connector-highlighted="isConnectorHighlighted"
		/>

		<!-- ───────────────────────── Connect ───────────────────────── -->
		<section v-if="step === 'connect'" class="space-y-5">
			<UiCard padding="lg">
				<template #header>
					<h2 class="font-semibold">Create a Google App Password</h2>
				</template>
				<p class="text-sm text-text-secondary">
					Gmail needs a one-time <strong>App Password</strong> for IMAP access (your normal
					password won't work). It takes about a minute and you can revoke it any time.
				</p>
				<ol class="mt-3 space-y-2 text-sm text-text-secondary list-decimal list-inside">
					<li>Turn on 2-Step Verification on your Google account (if it isn't already).</li>
					<li>
						Open
						<a
							href="https://myaccount.google.com/apppasswords"
							target="_blank"
							rel="noopener noreferrer"
							class="text-brand hover:underline inline-flex items-center gap-0.5"
						>
							Google App Passwords
							<Icon name="lucide:external-link" class="w-3 h-3" />
						</a>
						and create one named "Owlat".
					</li>
					<li>Copy the 16-character password and paste it below.</li>
				</ol>
			</UiCard>

			<UiCard padding="lg">
				<form class="space-y-4" @submit.prevent="handleConnectAndImport">
					<UiInput
						v-model="form.emailAddress"
						type="email"
						label="Gmail address"
						placeholder="you@gmail.com"
						autocomplete="email"
						required
					/>
					<UiInput
						v-model="form.password"
						type="password"
						label="App Password"
						placeholder="16-character app password"
						help-text="Stored encrypted — only the sync worker can read it."
						autocomplete="off"
						required
					/>

					<div v-if="testResult" class="text-sm space-y-1">
						<p :class="testResult.imap.ok ? 'text-success' : 'text-error'">
							<Icon
								:name="testResult.imap.ok ? 'lucide:check' : 'lucide:x'"
								class="w-3.5 h-3.5 inline"
							/>
							IMAP {{ testResult.imap.ok ? 'reachable' : (testResult.imap.error ?? 'failed') }}
						</p>
						<p :class="testResult.smtp.ok ? 'text-success' : 'text-error'">
							<Icon
								:name="testResult.smtp.ok ? 'lucide:check' : 'lucide:x'"
								class="w-3.5 h-3.5 inline"
							/>
							SMTP {{ testResult.smtp.ok ? 'reachable' : (testResult.smtp.error ?? 'failed') }}
						</p>
					</div>
					<UiErrorAlert v-if="formError" :message="formError" />

					<div class="flex items-center gap-3 pt-1">
						<UiButton
							type="submit"
							variant="primary"
							:loading="connectBusy"
							:disabled="!canSubmit || connectBusy"
						>
							Connect & import
						</UiButton>
						<UiButton
							type="button"
							variant="ghost"
							:loading="testOp.isLoading.value"
							:disabled="!canSubmit || connectBusy"
							@click="handleTest"
						>
							Test connection
						</UiButton>
					</div>
				</form>
			</UiCard>

			<p class="text-xs text-text-tertiary text-center">
				Not using Gmail?
				<NuxtLink to="/dashboard/postbox/settings/external-account" class="text-brand hover:underline">
					Connect another IMAP mailbox
				</NuxtLink>
			</p>
		</section>

		<!-- ───────────────────────── Ready ───────────────────────── -->
		<section v-else-if="step === 'ready'" class="space-y-5">
			<UiCard padding="lg">
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
				<div class="mt-5">
					<UiButton variant="primary" :loading="startBusy" @click="handleStartImport">
						Start import
					</UiButton>
				</div>
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
								"Your mailbox credentials aren't working. Update your App Password before importing — otherwise the import can't connect."
							}}
						</p>
					</div>
				</div>
				<div class="mt-5">
					<UiButton
						variant="primary"
						@click="navigateTo('/dashboard/postbox/settings/external-account')"
					>
						Update credentials
					</UiButton>
				</div>
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
					<UiProgressBar :value="indexPercent" variant="success" aria-label="AI learning progress" />
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
						Your Gmail history is in Owlat{{
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
	</div>
</template>
