<script setup lang="ts">
import { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import type { MailPreset, MailProvider } from '~/utils/mailAutodiscover';
import { presetForEmail, resolveMailPreset } from '~/utils/mailAutodiscover';
import { buildCredentialArgs, buildSharedConnectArgs } from '~/utils/postboxConnectArgs';

/**
 * The shared connect/edit form for the unified mail-import wizard. One form
 * serves every provider: a guided provider (Gmail, Fastmail, …) arrives with its
 * IMAP/SMTP servers pre-filled and hidden behind an "advanced" disclosure; the
 * generic IMAP provider shows the server fields up front and autodiscovers them
 * from the typed address. Credentials are handled exactly as the backend
 * expects — the password is sent to the AES-encrypting `connect`/`updateCredentials`
 * actions and never read back, so nothing here ever pre-fills it.
 */
const props = defineProps<{
	provider: MailProvider;
	mode: 'connect' | 'update';
	/** Existing connected account, for pre-filling non-secret fields when editing. */
	account?: {
		emailAddress: string;
		imapHost: string;
		imapPort: number;
		isImapSecure: boolean;
		smtpHost: string;
		smtpPort: number;
		isSmtpSecure: boolean;
		imapUsername: string;
		status?: string;
	} | null;
	/**
	 * Hide the Cancel/Back button. The reconnect step renders this form as the
	 * only way forward, so a cancel action there would do nothing — hide it.
	 */
	hideCancel?: boolean;
	/**
	 * Connect the account AS A SHARED TEAM INBOX (`connectShared`) instead of a
	 * personal 1:1 mailbox (`connect`). Only meaningful in `mode="connect"`. The
	 * connecting admin becomes the inbox owner; `memberUserIds` seed the roster
	 * and `displayName` names the inbox. See issue #234.
	 */
	shared?: boolean;
	/** Team-inbox display name (shared connect only). */
	displayName?: string;
	/** Initial member roster for a shared connect (org auth-user ids). */
	memberUserIds?: string[];
}>();

const emit = defineEmits<{
	/** Fired after a successful connect or update; carries the mailbox id. */
	(e: 'submitted', result?: { mailboxId: string }): void;
	/** Fired when the user backs out (connect mode → provider picker). */
	(e: 'cancel'): void;
}>();

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
// The server fields stop autofilling once the user (or a preset) has set them.
const serverFieldsTouched = ref(false);
// Guided providers hide the server settings; this reveals them on demand.
const showAdvanced = ref(props.provider.manualServer || props.mode === 'update');

type TestResult = FunctionReturnType<typeof api.mail.externalAccountsActions.testConnection>;
const testResult = ref<TestResult | null>(null);

// Copy the six IMAP/SMTP server fields from a preset (or an existing account,
// which shares the same shape) into the form. The single source of truth for
// the preset → form field mapping, reused by every seed/autofill site below.
function fillServerFields(preset: MailPreset) {
	form.imapHost = preset.imapHost;
	form.imapPort = preset.imapPort;
	form.isImapSecure = preset.isImapSecure;
	form.smtpHost = preset.smtpHost;
	form.smtpPort = preset.smtpPort;
	form.isSmtpSecure = preset.isSmtpSecure;
}

// Seed the form: the provider preset first, then the existing account's real
// settings when editing (those win, and never get clobbered by autodiscover).
if (props.provider.preset) {
	fillServerFields(props.provider.preset);
	serverFieldsTouched.value = true;
}

const a = props.account;
if (props.mode === 'update' && a) {
	form.emailAddress = a.emailAddress;
	fillServerFields(a);
	form.username = a.imapUsername;
	serverFieldsTouched.value = true;
}

function markServerFieldsTouched() {
	serverFieldsTouched.value = true;
}

// Autodiscover only helps the generic IMAP provider — guided providers already
// carry a preset. As the address is typed we fill untouched server fields from
// the domain (instant curated match, then a fail-soft network lookup).
let autodiscoverTimer: ReturnType<typeof setTimeout> | undefined;
let autodiscoverSeq = 0;
watch(
	() => form.emailAddress,
	(email) => {
		if (autodiscoverTimer) clearTimeout(autodiscoverTimer);
		if (!props.provider.manualServer || serverFieldsTouched.value) return;
		const known = presetForEmail(email);
		if (known) {
			fillServerFields(known);
			return;
		}
		const seq = ++autodiscoverSeq;
		autodiscoverTimer = setTimeout(() => {
			void resolveMailPreset(email).then((preset) => {
				if (seq !== autodiscoverSeq || serverFieldsTouched.value || !preset) return;
				fillServerFields(preset);
			});
		}, 500);
	}
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
const connectSharedOp = useBackendOperation(api.mail.externalAccountsActions.connectShared, {
	type: 'action',
	label: 'Connect team inbox',
	inlineTarget: formError,
});
const updateOp = useBackendOperation(api.mail.externalAccountsActions.updateCredentials, {
	type: 'action',
	label: 'Update mail credentials',
	inlineTarget: formError,
});

function buildArgs() {
	return buildCredentialArgs(form);
}

const busy = computed(
	() =>
		testOp.isLoading.value ||
		connectOp.isLoading.value ||
		connectSharedOp.isLoading.value ||
		updateOp.isLoading.value
);
const canSubmit = computed(
	() =>
		/^.+@.+\..+$/.test(form.emailAddress.trim()) &&
		form.password.trim().length > 0 &&
		form.imapHost.trim().length > 0 &&
		form.smtpHost.trim().length > 0
);
// A real connection test needs the password (never pre-filled), plus servers.
const canTest = computed(
	() => !!form.imapHost.trim() && !!form.smtpHost.trim() && !!form.password.trim()
);

async function handleTest() {
	testResult.value = null;
	const res = await testOp.run(buildArgs());
	if (res) testResult.value = res;
}

async function handleSubmit() {
	// A shared connect provisions a team inbox (connectShared) with the picked
	// roster; every other case is the personal connect / credential update.
	const res =
		props.mode === 'connect' && props.shared
			? await connectSharedOp.run(
					buildSharedConnectArgs(form, {
						displayName: props.displayName,
						memberUserIds: props.memberUserIds ?? [],
					})
				)
			: await (props.mode === 'update' ? updateOp : connectOp).run(buildArgs());
	if (res === undefined) return;
	form.password = '';
	emit('submitted', { mailboxId: res.mailboxId });
}

// Sharpen the app-password callout when the mailbox is actively failing auth or
// a test just failed on credentials — otherwise it's a proactive heads-up.
function looksLikeAuthError(error?: string): boolean {
	return !!error && /auth|password|credential|login|denied|invalid/i.test(error);
}
const hasAuthError = computed(() => {
	if (props.account?.status === 'auth_error') return true;
	const r = testResult.value;
	if (!r) return false;
	return (
		(!r.imap.ok && looksLikeAuthError(r.imap.error)) ||
		(!r.smtp.ok && looksLikeAuthError(r.smtp.error))
	);
});

const submitLabel = computed(() =>
	props.mode === 'update'
		? 'Save credentials'
		: props.shared
			? 'Connect team inbox'
			: 'Connect & import'
);
</script>

<template>
	<form class="space-y-5" @submit.prevent="handleSubmit">
		<PostboxAppPasswordCallout
			v-if="provider.appPassword"
			:help="provider.appPassword"
			:auth-error="hasAuthError"
		/>

		<UiInput
			v-model="form.emailAddress"
			type="email"
			:label="`${provider.name} address`"
			placeholder="you@example.com"
			autocomplete="email"
			:disabled="mode === 'update'"
			required
		/>

		<UiInput
			v-model="form.password"
			type="password"
			label="Password"
			:placeholder="provider.appPassword ? 'Paste the app password' : 'App password recommended'"
			help-text="Stored encrypted — only the sync worker can read it."
			autocomplete="off"
			required
		/>

		<!-- Server settings: shown up front for generic IMAP, tucked away for guided providers. -->
		<div v-if="!provider.manualServer && mode === 'connect'">
			<button
				type="button"
				class="text-xs text-text-secondary hover:text-text-primary inline-flex items-center gap-1"
				@click="showAdvanced = !showAdvanced"
			>
				<Icon
					:name="showAdvanced ? 'lucide:chevron-down' : 'lucide:chevron-right'"
					class="w-3.5 h-3.5"
				/>
				Server settings
			</button>
		</div>

		<!-- Raw inputs (not UiInput) so a native `input` event fires only on real
		     typing — a programmatic autodiscover fill must not mark the fields
		     "touched" and switch autofill off. -->
		<div v-if="showAdvanced" class="space-y-4">
			<div class="grid grid-cols-2 gap-4">
				<div>
					<label for="connect-imaphost" class="text-sm font-medium block mb-1">IMAP host</label>
					<input
						id="connect-imaphost"
						v-model="form.imapHost"
						type="text"
						placeholder="imap.example.com"
						class="input w-full"
						@input="markServerFieldsTouched"
					/>
				</div>
				<div class="flex gap-2">
					<div class="flex-1">
						<label for="connect-imapport" class="text-sm font-medium block mb-1">IMAP port</label>
						<input
							id="connect-imapport"
							v-model.number="form.imapPort"
							type="number"
							class="input w-full"
							@input="markServerFieldsTouched"
						/>
					</div>
					<label class="flex items-center gap-1.5 text-sm self-end pb-2">
						<input v-model="form.isImapSecure" type="checkbox" @change="markServerFieldsTouched" />
						SSL
					</label>
				</div>
			</div>
			<div class="grid grid-cols-2 gap-4">
				<div>
					<label for="connect-smtphost" class="text-sm font-medium block mb-1">SMTP host</label>
					<input
						id="connect-smtphost"
						v-model="form.smtpHost"
						type="text"
						placeholder="smtp.example.com"
						class="input w-full"
						@input="markServerFieldsTouched"
					/>
				</div>
				<div class="flex gap-2">
					<div class="flex-1">
						<label for="connect-smtpport" class="text-sm font-medium block mb-1">SMTP port</label>
						<input
							id="connect-smtpport"
							v-model.number="form.smtpPort"
							type="number"
							class="input w-full"
							@input="markServerFieldsTouched"
						/>
					</div>
					<label class="flex items-center gap-1.5 text-sm self-end pb-2">
						<input v-model="form.isSmtpSecure" type="checkbox" @change="markServerFieldsTouched" />
						SSL
					</label>
				</div>
			</div>
			<div>
				<label for="connect-username" class="text-sm font-medium block mb-1">Username</label>
				<input
					id="connect-username"
					v-model="form.username"
					type="text"
					placeholder="Defaults to your email address"
					class="input w-full"
				/>
			</div>
		</div>

		<div v-if="testResult" class="text-sm space-y-1">
			<p :class="testResult.imap.ok ? 'text-success' : 'text-error'">
				<Icon :name="testResult.imap.ok ? 'lucide:check' : 'lucide:x'" class="w-3.5 h-3.5 inline" />
				IMAP {{ testResult.imap.ok ? 'reachable' : (testResult.imap.error ?? 'failed') }}
			</p>
			<p :class="testResult.smtp.ok ? 'text-success' : 'text-error'">
				<Icon :name="testResult.smtp.ok ? 'lucide:check' : 'lucide:x'" class="w-3.5 h-3.5 inline" />
				SMTP {{ testResult.smtp.ok ? 'reachable' : (testResult.smtp.error ?? 'failed') }}
			</p>
		</div>

		<UiErrorAlert v-if="formError" :message="formError" />

		<div class="flex flex-wrap items-center gap-3 pt-1">
			<UiButton type="submit" variant="primary" :loading="busy" :disabled="!canSubmit || busy">
				{{ submitLabel }}
			</UiButton>
			<UiButton
				type="button"
				variant="ghost"
				:loading="testOp.isLoading.value"
				:disabled="!canTest || busy"
				:title="!form.password.trim() ? 'Enter the password to test the connection' : undefined"
				@click="handleTest"
			>
				Test connection
			</UiButton>
			<UiButton
				v-if="!hideCancel"
				type="button"
				variant="ghost"
				:disabled="busy"
				@click="emit('cancel')"
			>
				{{ mode === 'update' ? 'Cancel' : 'Back' }}
			</UiButton>
		</div>
	</form>
</template>
