<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
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
	 * Operate on a SHARED TEAM INBOX instead of a personal 1:1 mailbox. In
	 * `mode="connect"` this provisions the inbox via `connectShared` (the admin
	 * becomes owner; `memberUserIds` seed the roster, `displayName` names it); in
	 * `mode="update"` it rotates the team inbox's credentials via
	 * `updateCredentialsShared` (needs `mailboxId`). See issue #234.
	 */
	shared?: boolean;
	/** Team-inbox display name (shared connect only). */
	displayName?: string;
	/** Initial member roster for a shared connect (org auth-user ids). */
	memberUserIds?: string[];
	/** The team inbox being repaired — required for a shared credential update. */
	mailboxId?: Id<'mailboxes'>;
	/** Deliverability test-mailbox mode; stores the account outside personal Postbox. */
	seedProvider?: DestinationProviderKey;
}>();

const emit = defineEmits<{
	/** Fired after a successful connect or update; carries the mailbox id. */
	(e: 'submitted', result?: { mailboxId: string }): void;
	/** Fired when the user backs out (connect mode → provider picker). */
	(e: 'cancel'): void;
}>();

const { t } = useI18n();

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
const showAdvanced = ref(props.mode === 'update');

type TestResult = FunctionReturnType<typeof api.mail.external.accountsActions.testConnection>;
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

const testOp = useBackendOperation(api.mail.external.accountsActions.testConnection, {
	type: 'action',
	label: () => t('components.postbox.postboxMailboxConnectForm.testOperation'),
	inlineTarget: formError,
});
const connectOp = useBackendOperation(api.mail.external.accountsActions.connect, {
	type: 'action',
	label: () => t('components.postbox.postboxMailboxConnectForm.connectOperation'),
	inlineTarget: formError,
});
const connectSharedOp = useBackendOperation(api.mail.external.accountsActions.connectShared, {
	type: 'action',
	label: () => t('components.postbox.postboxMailboxConnectForm.connectSharedOperation'),
	inlineTarget: formError,
});
const connectSeedOp = useBackendOperation(api.mail.external.accountsActions.connectSeed, {
	type: 'action',
	label: () => t('components.postbox.postboxMailboxConnectForm.connectSeedOperation'),
	inlineTarget: formError,
});
const updateOp = useBackendOperation(api.mail.external.accountsActions.updateCredentials, {
	type: 'action',
	label: () => t('components.postbox.postboxMailboxConnectForm.updateOperation'),
	inlineTarget: formError,
});
const updateSharedOp = useBackendOperation(
	api.mail.external.accountsActions.updateCredentialsShared,
	{
		type: 'action',
		label: () => t('components.postbox.postboxMailboxConnectForm.updateSharedOperation'),
		inlineTarget: formError,
	}
);

const busy = computed(
	() =>
		testOp.isLoading.value ||
		connectOp.isLoading.value ||
		connectSharedOp.isLoading.value ||
		connectSeedOp.isLoading.value ||
		updateOp.isLoading.value ||
		updateSharedOp.isLoading.value
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
	const res = await testOp.run(buildCredentialArgs(form));
	if (res.ok) testResult.value = res.result;
}

async function handleSubmit() {
	// Five cases, keyed on (mode, shared, seedProvider): a seed connect provisions
	// an operator-owned deliverability mailbox; a shared connect provisions a team
	// inbox (connectShared) with the picked roster; a shared update rotates a team
	// inbox's credentials (updateCredentialsShared, keyed by mailboxId); the rest
	// are the personal connect / credential update.
	let res: BackendOperationResult<{ mailboxId: string }>;
	if (props.mode === 'connect' && props.seedProvider) {
		res = await connectSeedOp.run({
			...buildCredentialArgs(form),
			seedProvider: props.seedProvider,
		});
	} else if (props.mode === 'connect' && props.shared) {
		res = await connectSharedOp.run(
			buildSharedConnectArgs(form, {
				displayName: props.displayName,
				memberUserIds: props.memberUserIds ?? [],
			})
		);
	} else if (props.mode === 'update' && props.shared) {
		// A shared credential rotation is keyed by the team inbox's mailboxId. Guard
		// its absence explicitly rather than falling through to the PERSONAL
		// `updateCredentials` below, which would rewrite the caller's own external
		// account with this team inbox's servers/password (a silent wrong target).
		if (!props.mailboxId) {
			formError.value = t('components.postbox.postboxMailboxConnectForm.missingMailboxError');
			return;
		}
		res = await updateSharedOp.run({ ...buildCredentialArgs(form), mailboxId: props.mailboxId });
	} else {
		res = await (props.mode === 'update' ? updateOp : connectOp).run(buildCredentialArgs(form));
	}
	if (!res.ok) return;
	form.password = '';
	emit('submitted', { mailboxId: res.result.mailboxId });
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

// `MailProvider.name` is a CATALOG KEY, not display copy (see
// `utils/mailAutodiscover`), so it has to be translated before it is
// interpolated into the address label — interpolating it raw paints
// `shared.mailAutodiscover.provider.gmail.name` on the visible field label.
const providerName = computed(() => t(props.provider.name));

const submitLabel = computed(() =>
	props.mode === 'update'
		? t('components.postbox.postboxMailboxConnectForm.saveCredentials')
		: props.shared
			? t('components.postbox.postboxMailboxConnectForm.connectShared')
			: props.seedProvider
				? t('components.postbox.postboxMailboxConnectForm.connectSeed')
				: t('components.postbox.postboxMailboxConnectForm.connect')
);

// The two connection-test lines read "<direction> mail <status>", where the
// status is either a translated word or the server's raw error text.
const imapStatus = computed(() => testStatus(testResult.value?.imap));
const smtpStatus = computed(() => testStatus(testResult.value?.smtp));

function testStatus(result?: { ok: boolean; error?: string }): string {
	if (!result) return '';
	if (result.ok) return t('components.postbox.postboxMailboxConnectForm.reachable');
	return result.error ?? t('components.postbox.postboxMailboxConnectForm.failed');
}
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
			:label="
				t('components.postbox.postboxMailboxConnectForm.addressLabel', { provider: providerName })
			"
			:placeholder="t('components.postbox.postboxMailboxConnectForm.emailPlaceholder')"
			autocomplete="email"
			:disabled="mode === 'update'"
			required
		/>

		<UiInput
			v-model="form.password"
			type="password"
			:label="t('components.postbox.postboxMailboxConnectForm.passwordLabel')"
			:placeholder="
				provider.appPassword
					? t('components.postbox.postboxMailboxConnectForm.appPasswordPlaceholder')
					: t('components.postbox.postboxMailboxConnectForm.passwordPlaceholder')
			"
			:help-text="t('components.postbox.postboxMailboxConnectForm.passwordHelp')"
			autocomplete="off"
			required
		/>

		<!-- Raw inputs (not UiInput) so a native `input` event fires only on real
		     typing — a programmatic autodiscover fill must not mark the fields
		     "touched" and switch autofill off. -->
		<UiDisclosure
			v-model="showAdvanced"
			controls="mail-server-settings"
			:label="t('components.postbox.postboxMailboxConnectForm.advancedSettings')"
		>
			<div class="space-y-4">
				<div class="grid grid-cols-2 gap-4">
					<div>
						<label for="connect-imaphost" class="text-sm font-medium block mb-1">{{
							t('components.postbox.postboxMailboxConnectForm.imapHost')
						}}</label>
						<input
							id="connect-imaphost"
							v-model="form.imapHost"
							type="text"
							:placeholder="t('components.postbox.postboxMailboxConnectForm.imapHostPlaceholder')"
							class="input w-full"
							@input="markServerFieldsTouched"
						/>
					</div>
					<div class="flex gap-2">
						<div class="flex-1">
							<label for="connect-imapport" class="text-sm font-medium block mb-1">{{
								t('components.postbox.postboxMailboxConnectForm.imapPort')
							}}</label>
							<input
								id="connect-imapport"
								v-model.number="form.imapPort"
								type="number"
								class="input w-full"
								@input="markServerFieldsTouched"
							/>
						</div>
						<label class="flex items-center gap-1.5 text-sm self-end pb-2">
							<input
								v-model="form.isImapSecure"
								type="checkbox"
								@change="markServerFieldsTouched"
							/>
							{{ t('components.postbox.postboxMailboxConnectForm.ssl') }}
						</label>
					</div>
				</div>
				<div class="grid grid-cols-2 gap-4">
					<div>
						<label for="connect-smtphost" class="text-sm font-medium block mb-1">{{
							t('components.postbox.postboxMailboxConnectForm.smtpHost')
						}}</label>
						<input
							id="connect-smtphost"
							v-model="form.smtpHost"
							type="text"
							:placeholder="t('components.postbox.postboxMailboxConnectForm.smtpHostPlaceholder')"
							class="input w-full"
							@input="markServerFieldsTouched"
						/>
					</div>
					<div class="flex gap-2">
						<div class="flex-1">
							<label for="connect-smtpport" class="text-sm font-medium block mb-1">{{
								t('components.postbox.postboxMailboxConnectForm.smtpPort')
							}}</label>
							<input
								id="connect-smtpport"
								v-model.number="form.smtpPort"
								type="number"
								class="input w-full"
								@input="markServerFieldsTouched"
							/>
						</div>
						<label class="flex items-center gap-1.5 text-sm self-end pb-2">
							<input
								v-model="form.isSmtpSecure"
								type="checkbox"
								@change="markServerFieldsTouched"
							/>
							{{ t('components.postbox.postboxMailboxConnectForm.ssl') }}
						</label>
					</div>
				</div>
				<div>
					<label for="connect-username" class="text-sm font-medium block mb-1">{{
						t('components.postbox.postboxMailboxConnectForm.username')
					}}</label>
					<input
						id="connect-username"
						v-model="form.username"
						type="text"
						:placeholder="t('components.postbox.postboxMailboxConnectForm.usernamePlaceholder')"
						class="input w-full"
					/>
				</div>
			</div>
		</UiDisclosure>

		<div v-if="testResult" class="text-sm space-y-1">
			<p :class="testResult.imap.ok ? 'text-success' : 'text-error'">
				<Icon :name="testResult.imap.ok ? 'lucide:check' : 'lucide:x'" class="w-3.5 h-3.5 inline" />
				{{ t('components.postbox.postboxMailboxConnectForm.incomingMail', { status: imapStatus }) }}
			</p>
			<p :class="testResult.smtp.ok ? 'text-success' : 'text-error'">
				<Icon :name="testResult.smtp.ok ? 'lucide:check' : 'lucide:x'" class="w-3.5 h-3.5 inline" />
				{{ t('components.postbox.postboxMailboxConnectForm.outgoingMail', { status: smtpStatus }) }}
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
				:title="
					!form.password.trim()
						? t('components.postbox.postboxMailboxConnectForm.testNeedsPassword')
						: undefined
				"
				@click="handleTest"
			>
				{{ t('components.postbox.postboxMailboxConnectForm.testConnection') }}
			</UiButton>
			<UiButton
				v-if="!hideCancel"
				type="button"
				variant="ghost"
				:disabled="busy"
				@click="emit('cancel')"
			>
				{{ mode === 'update' ? t('common.cancel') : t('common.back') }}
			</UiButton>
		</div>
	</form>
</template>
