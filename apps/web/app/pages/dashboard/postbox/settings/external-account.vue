<script setup lang="ts">
import { api } from '@owlat/api';
import { appPasswordHelpForEmail, presetForEmail, resolveMailPreset } from '~/utils/mailAutodiscover';

useHead({ title: 'Connect external mailbox — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const { showToast } = useToast();

const { data: accountData, isLoading } = useConvexQuery(
	api.mail.externalAccounts.getForCurrentUser,
	() => ({}),
);
const account = computed(() => accountData.value ?? null);
const isConnected = computed(() => account.value?.configured === true);

const form = reactive({
	emailAddress: '',
	imapHost: '',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: '',
	smtpPort: 465,
	isSmtpSecure: true,
	username: '',
	password: '',
});
const formError = ref<string | null>(null);
const editing = ref(false);
// Autodiscover backs off once the user (or a preset button / existing-account
// pre-fill) has set the server fields, so we never overwrite their choices.
const serverFieldsTouched = ref(false);
const showDisconnect = ref(false);
const showPurge = ref(false);
type TestResult = { imap: { ok: boolean; error?: string }; smtp: { ok: boolean; error?: string } };
const testResult = ref<TestResult | null>(null);

// Pre-fill non-secret fields when editing an existing connection.
watchEffect(() => {
	const a = account.value;
	if (a?.configured && !editing.value && !form.emailAddress) {
		form.emailAddress = a.emailAddress;
		form.imapHost = a.imapHost;
		form.imapPort = a.imapPort;
		form.isImapSecure = a.isImapSecure;
		form.smtpHost = a.smtpHost;
		form.smtpPort = a.smtpPort;
		form.isSmtpSecure = a.isSmtpSecure;
		form.username = a.imapUsername;
		// These are the account's real settings — don't let autodiscover clobber them.
		serverFieldsTouched.value = true;
	}
});

const PRESETS: Record<string, Partial<typeof form>> = {
	Gmail: { imapHost: 'imap.gmail.com', imapPort: 993, isImapSecure: true, smtpHost: 'smtp.gmail.com', smtpPort: 465, isSmtpSecure: true },
	Fastmail: { imapHost: 'imap.fastmail.com', imapPort: 993, isImapSecure: true, smtpHost: 'smtp.fastmail.com', smtpPort: 465, isSmtpSecure: true },
	iCloud: { imapHost: 'imap.mail.me.com', imapPort: 993, isImapSecure: true, smtpHost: 'smtp.mail.me.com', smtpPort: 587, isSmtpSecure: false },
	'Outlook.com': { imapHost: 'outlook.office365.com', imapPort: 993, isImapSecure: true, smtpHost: 'smtp-mail.outlook.com', smtpPort: 587, isSmtpSecure: false },
};
function applyPreset(name: keyof typeof PRESETS) {
	Object.assign(form, PRESETS[name]);
	serverFieldsTouched.value = true;
}

// Autodiscover: as the user types their email address, pre-fill the server
// fields from its domain (curated preset, then a fail-soft Thunderbird
// autoconfig lookup). We only ever fill fields the user hasn't touched — once
// they edit a host/port/SSL box (or click a preset button) autofill backs off.
function markServerFieldsTouched() {
	serverFieldsTouched.value = true;
}

function applyAutodiscoveredPreset(preset: {
	imapHost: string;
	imapPort: number;
	isImapSecure: boolean;
	smtpHost: string;
	smtpPort: number;
	isSmtpSecure: boolean;
}) {
	// Guard again — the reply may land after the user started editing.
	if (serverFieldsTouched.value) return;
	form.imapHost = preset.imapHost;
	form.imapPort = preset.imapPort;
	form.isImapSecure = preset.isImapSecure;
	form.smtpHost = preset.smtpHost;
	form.smtpPort = preset.smtpPort;
	form.isSmtpSecure = preset.isSmtpSecure;
}

let autodiscoverTimer: ReturnType<typeof setTimeout> | undefined;
let autodiscoverSeq = 0;
watch(
	() => form.emailAddress,
	(email) => {
		if (autodiscoverTimer) clearTimeout(autodiscoverTimer);
		if (serverFieldsTouched.value) return;
		// Instant, offline match first so the common providers fill with no wait.
		const known = presetForEmail(email);
		if (known) {
			applyAutodiscoveredPreset(known);
			return;
		}
		// Debounce the network fallback so we don't fire on every keystroke.
		const seq = ++autodiscoverSeq;
		autodiscoverTimer = setTimeout(() => {
			void resolveMailPreset(email).then((preset) => {
				// Ignore stale replies and anyone who started editing meanwhile.
				if (seq !== autodiscoverSeq || serverFieldsTouched.value || !preset) return;
				applyAutodiscoveredPreset(preset);
			});
		}, 500);
	},
);
onBeforeUnmount(() => {
	if (autodiscoverTimer) clearTimeout(autodiscoverTimer);
});

const testOp = useBackendOperation(api.mail.externalAccountsActions.testConnection, {
	type: 'action',
	label: 'Test mail connection',
	inlineTarget: formError,
});
const connectOp = useBackendOperation(api.mail.externalAccountsActions.connect, {
	type: 'action',
	label: 'Connect mailbox',
	inlineTarget: formError,
});
const updateOp = useBackendOperation(api.mail.externalAccountsActions.updateCredentials, {
	type: 'action',
	label: 'Update mail credentials',
	inlineTarget: formError,
});
const disconnectOp = useBackendOperation(api.mail.externalAccounts.disconnect, {
	label: 'Disconnect mailbox',
});
const purgeOp = useBackendOperation(api.mail.externalAccounts.purge, {
	label: 'Delete mailbox and synced data',
});

function buildArgs() {
	return {
		emailAddress: form.emailAddress.trim(),
		imapHost: form.imapHost.trim(),
		imapPort: Number(form.imapPort),
		isImapSecure: form.isImapSecure,
		smtpHost: form.smtpHost.trim(),
		smtpPort: Number(form.smtpPort),
		isSmtpSecure: form.isSmtpSecure,
		username: (form.username || form.emailAddress).trim(),
		password: form.password,
	};
}

const busy = computed(
	() => testOp.isLoading.value || connectOp.isLoading.value || updateOp.isLoading.value,
);

// The password field is intentionally never pre-filled when editing an existing
// connection, but a real connection test still needs it — without it the test
// always fails with a misleading "auth failed". Require a password to test.
const canTest = computed(
	() => !!form.imapHost.trim() && !!form.smtpHost.trim() && !!form.password.trim(),
);

async function handleTest() {
	testResult.value = null;
	const res = await testOp.run(buildArgs());
	if (res) testResult.value = res as TestResult;
}

async function handleConnect() {
	const res = await connectOp.run(buildArgs());
	if (res === undefined) return;
	form.password = '';
	showToast('Mailbox connected — Owlat is syncing your mail now.', 'success');
	await navigateTo('/dashboard/postbox/inbox');
}

async function handleUpdate() {
	const res = await updateOp.run(buildArgs());
	if (res === undefined) return;
	form.password = '';
	editing.value = false;
	testResult.value = null;
	showToast('Credentials updated.', 'success');
}

function openDisconnect() {
	showPurge.value = false;
	showDisconnect.value = true;
}

function openPurge() {
	showDisconnect.value = false;
	showPurge.value = true;
}

async function handleDisconnect() {
	const res = await disconnectOp.run({});
	showDisconnect.value = false;
	if (res !== undefined) {
		showToast('Mailbox disconnected.', 'success');
	}
}

async function handlePurge() {
	const res = await purgeOp.run({});
	showPurge.value = false;
	if (res !== undefined) {
		showToast('Mailbox and all synced data are being deleted.', 'success');
	}
}

const statusLabel = computed(() => {
	switch (account.value?.status) {
		case 'connected': return 'Connected';
		case 'pending': return 'Connecting…';
		case 'auth_error': return 'Authentication failed';
		case 'error': return 'Connection error';
		default: return account.value?.status ?? 'Unknown';
	}
});
const statusClass = computed(() => {
	switch (account.value?.status) {
		case 'connected': return 'bg-success-subtle text-success';
		case 'pending': return 'bg-info-subtle text-info';
		case 'auth_error':
		case 'error': return 'bg-error-subtle text-error';
		default: return 'bg-bg-surface text-text-tertiary';
	}
});

const showForm = computed(() => !isConnected.value || editing.value);

// App-password deep-link guidance. The big consumer providers reject a plain
// account password over IMAP/SMTP once 2FA is on and require a provider-minted
// "app password" — by far the most common cause of an auth error here. We show
// an actionable callout (deep link + one line of steps) whenever the email
// domain is a provider we know requires an app password. Pure/offline lookup.
const detectedEmail = computed(() => form.emailAddress || account.value?.emailAddress || '');
const appPasswordProvider = computed(() => appPasswordHelpForEmail(detectedEmail.value));

// Whether the mailbox is actively failing on credentials (backend status or a
// failed connection test). Sharpens the callout wording via the `auth-error`
// prop — a proactive hint when false, a "this is why it failed" fix when true.
function looksLikeAuthError(error?: string): boolean {
	return !!error && /auth|password|credential|login|denied|invalid/i.test(error);
}
const hasAuthError = computed(() => {
	if (account.value?.status === 'auth_error') return true;
	const r = testResult.value;
	if (!r) return false;
	return (!r.imap.ok && looksLikeAuthError(r.imap.error)) || (!r.smtp.ok && looksLikeAuthError(r.smtp.error));
});
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

		<h1 class="text-2xl font-semibold">Connect an external mailbox</h1>
		<p class="text-text-secondary mt-1">
			Use your existing email account (Gmail, Fastmail, a company server) over IMAP + SMTP — no
			sending domain required.
		</p>

		<div v-if="isLoading" class="mt-6 flex justify-center">
			<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
		</div>

		<!-- Connected summary -->
		<section v-else-if="isConnected && !editing" class="card mt-6 p-6 space-y-4">
			<div class="flex items-start justify-between">
				<div>
					<p class="font-semibold">{{ account?.emailAddress }}</p>
					<p class="text-xs text-text-tertiary mt-0.5">
						IMAP {{ account?.imapHost }}:{{ account?.imapPort }} · SMTP
						{{ account?.smtpHost }}:{{ account?.smtpPort }}
					</p>
				</div>
				<span class="text-xs px-2 py-0.5 rounded" :class="statusClass">{{ statusLabel }}</span>
			</div>

			<p v-if="account?.lastError" class="text-sm text-error">
				{{ account.lastError }}
			</p>
			<p v-if="account?.status === 'auth_error'" class="text-sm text-text-secondary">
				Re-enter your password below to reconnect. For Gmail / Outlook you may need an
				<strong>app password</strong> (with 2-factor enabled).
			</p>

			<PostboxAppPasswordCallout
				v-if="appPasswordProvider"
				:help="appPasswordProvider"
				:auth-error="hasAuthError"
			/>

			<div class="flex flex-wrap items-center gap-3 pt-2">
				<button type="button" class="btn btn-secondary" @click="editing = true">
					Update credentials
				</button>
				<button type="button" class="btn btn-ghost text-error" @click="openDisconnect">
					Disconnect
				</button>
				<button type="button" class="btn btn-ghost text-error" @click="openPurge">
					Delete mailbox and synced data
				</button>
			</div>

			<div v-if="showDisconnect" class="rounded-lg border border-border-subtle p-4 bg-bg-surface">
				<p class="text-sm">
					Disconnect this mailbox? Syncing stops and it's hidden from your inbox. Synced
					messages are retained unless you delete them separately.
				</p>
				<div class="flex items-center gap-2 mt-3">
					<button
						type="button"
						class="btn btn-sm btn-danger"
						:disabled="disconnectOp.isLoading.value"
						@click="handleDisconnect"
					>
						Disconnect
					</button>
					<button type="button" class="btn btn-sm btn-ghost" @click="showDisconnect = false">
						Cancel
					</button>
				</div>
			</div>

				<div v-if="showPurge" class="rounded-lg border border-error-subtle p-4 bg-bg-surface">
					<p class="text-sm">
						Permanently delete this mailbox and <strong>all synced data</strong>? Every imported
						message, draft, folder and label is erased and cannot be recovered. Use this if you
						connected the wrong mailbox or want your imported mail genuinely removed (GDPR-style).
					</p>
					<div class="flex items-center gap-2 mt-3">
						<button
							type="button"
							class="btn btn-sm btn-danger"
							:disabled="purgeOp.isLoading.value"
							@click="handlePurge"
						>
							<Icon
								v-if="purgeOp.isLoading.value"
								name="lucide:loader-2"
								class="w-3.5 h-3.5 mr-1 animate-spin"
							/>
							Delete everything
						</button>
						<button type="button" class="btn btn-sm btn-ghost" @click="showPurge = false">
							Cancel
						</button>
					</div>
				</div>
		</section>

		<!-- Connect / edit form -->
		<section v-else-if="showForm" class="card mt-6 p-6 space-y-5">
			<div>
				<label class="text-sm font-medium block mb-1.5">Quick setup</label>
				<div class="flex flex-wrap gap-2">
					<button
						v-for="name in Object.keys(PRESETS)"
						:key="name"
						type="button"
						class="btn btn-sm btn-secondary"
						@click="applyPreset(name as keyof typeof PRESETS)"
					>
						{{ name }}
					</button>
				</div>
			</div>

			<div>
				<label for="form-emailaddress" class="text-sm font-medium block mb-1">Email address</label>
				<input id="form-emailaddress" v-model="form.emailAddress" type="email" placeholder="you@example.com" class="input w-full" />
			</div>

			<div class="grid grid-cols-2 gap-4">
				<div>
					<label for="form-imaphost" class="text-sm font-medium block mb-1">IMAP host</label>
					<input id="form-imaphost" v-model="form.imapHost" type="text" placeholder="imap.example.com" class="input w-full" @input="markServerFieldsTouched" />
				</div>
				<div class="flex gap-2">
					<div class="flex-1">
						<label for="form-imapport" class="text-sm font-medium block mb-1">IMAP port</label>
						<input id="form-imapport" v-model.number="form.imapPort" type="number" class="input w-full" @input="markServerFieldsTouched" />
					</div>
					<label class="flex items-center gap-1.5 text-sm self-end pb-2">
						<input v-model="form.isImapSecure" type="checkbox" @change="markServerFieldsTouched" />
						SSL
					</label>
				</div>
			</div>

			<div class="grid grid-cols-2 gap-4">
				<div>
					<label for="form-smtphost" class="text-sm font-medium block mb-1">SMTP host</label>
					<input id="form-smtphost" v-model="form.smtpHost" type="text" placeholder="smtp.example.com" class="input w-full" @input="markServerFieldsTouched" />
				</div>
				<div class="flex gap-2">
					<div class="flex-1">
						<label for="form-smtpport" class="text-sm font-medium block mb-1">SMTP port</label>
						<input id="form-smtpport" v-model.number="form.smtpPort" type="number" class="input w-full" @input="markServerFieldsTouched" />
					</div>
					<label class="flex items-center gap-1.5 text-sm self-end pb-2">
						<input v-model="form.isSmtpSecure" type="checkbox" @change="markServerFieldsTouched" />
						SSL
					</label>
				</div>
			</div>

			<div>
				<label for="form-username" class="text-sm font-medium block mb-1">Username</label>
				<input id="form-username" v-model="form.username" type="text" placeholder="Defaults to your email address" class="input w-full" />
			</div>

			<div>
				<label for="form-password" class="text-sm font-medium block mb-1">Password</label>
				<input id="form-password" v-model="form.password" type="password" placeholder="App password recommended" class="input w-full" autocomplete="off" />
				<p class="text-xs text-text-tertiary mt-1">
					Stored encrypted. Gmail / Outlook require an app password (2-factor enabled).
				</p>
			</div>

			<PostboxAppPasswordCallout
				v-if="appPasswordProvider"
				:help="appPasswordProvider"
				:auth-error="hasAuthError"
			/>

			<div v-if="testResult" class="text-sm space-y-1">
				<p :class="testResult.imap.ok ? 'text-success' : 'text-error'">
					<Icon :name="testResult.imap.ok ? 'lucide:check' : 'lucide:x'" class="w-3.5 h-3.5 inline" />
					IMAP: {{ testResult.imap.ok ? 'connected' : testResult.imap.error }}
				</p>
				<p :class="testResult.smtp.ok ? 'text-success' : 'text-error'">
					<Icon :name="testResult.smtp.ok ? 'lucide:check' : 'lucide:x'" class="w-3.5 h-3.5 inline" />
					SMTP: {{ testResult.smtp.ok ? 'connected' : testResult.smtp.error }}
				</p>
			</div>

			<div v-if="formError" class="text-sm text-error">{{ formError }}</div>

			<div class="flex items-center gap-3">
				<button
					type="button"
					class="btn btn-primary"
					:disabled="busy || !form.emailAddress || !form.imapHost || !form.smtpHost"
					@click="isConnected ? handleUpdate() : handleConnect()"
				>
					<Icon v-if="busy" name="lucide:loader-2" class="w-4 h-4 mr-1.5 animate-spin" />
					{{ isConnected ? 'Save credentials' : 'Connect mailbox' }}
				</button>
				<button
					type="button"
					class="btn btn-secondary"
					:disabled="busy || !canTest"
					:title="!form.password.trim() ? 'Enter the password to test the connection' : undefined"
					@click="handleTest"
				>
					Test connection
				</button>
				<span v-if="isConnected && !form.password.trim()" class="text-xs text-text-tertiary">
					Re-enter the password to test.
				</span>
				<button v-if="editing" type="button" class="btn btn-ghost" @click="editing = false">
					Cancel
				</button>
			</div>
		</section>
	</div>
</template>
