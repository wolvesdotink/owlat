<script setup lang="ts">
import {
	OUTBOUND_TLS_MODE_OPTIONS,
	seedOutboundTlsMode,
	type OutboundTlsMode,
} from '~/composables/setupOutboundTls';
import {
	SMTP_RELAY_PRESETS,
	buildProviderEnv,
	emailStepIsValid,
	validateEmailStep,
	type EmailStepDraft,
	type ProviderChoice,
	type SmtpPreset,
} from '~/composables/useSetupWizard';

/**
 * In-app transport editor. Reuses the setup wizard's provider picker, SMTP
 * presets, live-handshake validation, and `buildProviderEnv` so an admin can
 * change the sending provider + credentials, TEST them, and APPLY them without
 * ever hand-editing `.env`. Existing secrets are NEVER shown — the credential
 * fields start blank, and applying re-enters them; the backend never returns a
 * value. Editing is an explicit action revealed behind "Change provider".
 */

const props = defineProps<{
	/** The active EMAIL_PROVIDER kind from the status query (null when unset). */
	currentProvider: string | null;
	/**
	 * The active OUTBOUND_TLS_MODE for the built-in MTA (null when unset). Not a
	 * secret, so it is surfaced to seed the editor — otherwise re-applying any
	 * transport edit would silently reset a previously-chosen floor back to
	 * `opportunistic`.
	 */
	currentOutboundTlsMode?: string | null;
}>();

const emit = defineEmits<{ applied: [] }>();

const { showToast } = useToast();

const isEditing = ref(false);

// ── Draft (seeded from the active kind; credentials always blank) ────────────
function knownKind(kind: string | null): ProviderChoice {
	return kind === 'mta' || kind === 'resend' || kind === 'ses' || kind === 'smtp' ? kind : 'mta';
}

const provider = ref<ProviderChoice>(knownKind(props.currentProvider));
const resendKey = ref('');
const sesRegion = ref('us-east-1');
const sesAccess = ref('');
const sesSecret = ref('');
const fromEmail = ref('');
const fromName = ref('');
// Outbound TLS posture for the built-in MTA (direct-MX). Seeded from the active
// mode (via the shared `seedOutboundTlsMode`) so re-applying an edit preserves a
// previously-chosen floor; falls back to the `opportunistic` backend default
// (today's behaviour) when unset/unknown.
const outboundTlsMode = ref<OutboundTlsMode>(seedOutboundTlsMode(props.currentOutboundTlsMode));
const outboundTlsModeOptions = OUTBOUND_TLS_MODE_OPTIONS.map((o) => ({
	value: o.value,
	label: o.label,
}));
const outboundTlsModeHint = computed(
	() => OUTBOUND_TLS_MODE_OPTIONS.find((o) => o.value === outboundTlsMode.value)?.hint ?? ''
);

const smtpPreset = ref<SmtpPreset>('mailgun');
const smtpHost = ref(SMTP_RELAY_PRESETS['mailgun'].host);
const smtpPort = ref(SMTP_RELAY_PRESETS['mailgun'].port);
const smtpSecure = ref(SMTP_RELAY_PRESETS['mailgun'].secure);
const smtpUsername = ref('');
const smtpPassword = ref('');

const smtpPresetOptions = (Object.keys(SMTP_RELAY_PRESETS) as SmtpPreset[]).map((key) => ({
	value: key,
	label: SMTP_RELAY_PRESETS[key].label,
}));

// Choosing a named preset prefills host/port/TLS; Custom leaves them editable.
watch(smtpPreset, (preset) => {
	if (preset === 'custom') return;
	const cfg = SMTP_RELAY_PRESETS[preset];
	smtpHost.value = cfg.host;
	smtpPort.value = cfg.port;
	smtpSecure.value = cfg.secure;
});

const providerOptions: { value: ProviderChoice; label: string; hint: string; icon: string }[] = [
	{
		value: 'mta',
		label: 'Run your own MTA',
		hint: 'Full control, no third party. Needs port 25 open and a clean sending IP.',
		icon: 'lucide:server',
	},
	{
		value: 'ses',
		label: 'Amazon SES',
		hint: 'Managed deliverability, cheap at scale. Needs an AWS account.',
		icon: 'lucide:cloud',
	},
	{
		value: 'smtp',
		label: 'SMTP relay',
		hint: 'Mailgun, Postmark, SendGrid, Brevo, or any custom SMTP server.',
		icon: 'lucide:route',
	},
	{
		value: 'resend',
		label: 'Resend',
		hint: 'Managed API with a generous free tier.',
		icon: 'lucide:zap',
	},
];

const draft = computed<EmailStepDraft>(() => ({
	provider: provider.value,
	// The editor only ever sets a real transport, so the "none" branch of the
	// shared validator is unreachable here.
	requiresProvider: true,
	resendKey: resendKey.value,
	ses: { region: sesRegion.value, accessKeyId: sesAccess.value, secretAccessKey: sesSecret.value },
	smtp: {
		preset: smtpPreset.value,
		host: smtpHost.value,
		port: smtpPort.value,
		secure: smtpSecure.value,
		username: smtpUsername.value,
		password: smtpPassword.value,
	},
	outboundTlsMode: outboundTlsMode.value,
	fromEmail: fromEmail.value,
	fromName: fromName.value,
}));

const submitted = ref(false);
const errors = computed(() => validateEmailStep(draft.value));
const showErrors = computed(() => submitted.value);
const isValid = computed(() => emailStepIsValid(draft.value));

// Only Resend + SMTP have a pre-apply network handshake (the wizard is the same).
const canTest = computed(() => provider.value === 'resend' || provider.value === 'smtp');

// ── Test ─────────────────────────────────────────────────────────────────────
const testing = ref(false);
const testResult = ref<{ ok: boolean; message: string } | null>(null);

async function handleTest() {
	submitted.value = true;
	testResult.value = null;
	if (!isValid.value) return;
	testing.value = true;
	try {
		const trimmedPort = smtpPort.value.trim();
		const bodyBase =
			provider.value === 'resend'
				? { provider: 'resend' as const, apiKey: resendKey.value }
				: {
						provider: 'smtp' as const,
						smtp: {
							host: smtpHost.value.trim(),
							port: trimmedPort ? Number.parseInt(trimmedPort, 10) : 587,
							secure: smtpSecure.value,
							username: smtpUsername.value,
							password: smtpPassword.value,
						},
					};
		testResult.value = await $fetch<{ ok: boolean; message: string }>(
			'/api/delivery/validate-transport',
			{ method: 'POST', body: bodyBase }
		);
	} catch (e) {
		testResult.value = {
			ok: false,
			message: (e as Error).message || 'Could not reach the provider. Try again.',
		};
	} finally {
		testing.value = false;
	}
}

// ── Apply ────────────────────────────────────────────────────────────────────
const applying = ref(false);
const applyError = ref('');
const restartNotice = ref('');

async function handleApply() {
	submitted.value = true;
	applyError.value = '';
	restartNotice.value = '';
	if (!isValid.value) return;
	applying.value = true;
	try {
		// Identical env patch to the wizard's — pass an empty base so only the
		// transport keys are sent; the backend allowlists and clears the rest.
		const providerEnv = buildProviderEnv({}, draft.value);
		const res = await $fetch<{
			ok: boolean;
			message: string;
			applied: boolean;
			requiresRestart: boolean;
		}>('/api/delivery/apply-transport', { method: 'POST', body: { providerEnv } });
		if (!res.ok) {
			applyError.value = res.message;
			return;
		}
		if (res.requiresRestart) {
			restartNotice.value = res.message;
		} else {
			showToast(res.message);
			isEditing.value = false;
		}
		// Clear the entered secrets from memory once applied.
		resendKey.value = '';
		sesSecret.value = '';
		smtpPassword.value = '';
		emit('applied');
	} catch (e) {
		applyError.value = (e as Error).message || 'Could not apply the transport. Try again.';
	} finally {
		applying.value = false;
	}
}

function cancel() {
	isEditing.value = false;
	submitted.value = false;
	testResult.value = null;
	applyError.value = '';
	restartNotice.value = '';
}
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<template #header>
			<div class="flex items-center justify-between gap-3">
				<div class="flex items-center gap-3">
					<UiIconBox icon="lucide:pencil" size="sm" variant="surface" rounded="lg" />
					<div>
						<h2 class="text-lg font-semibold text-text-primary">Change provider</h2>
						<p class="text-sm text-text-secondary">
							Switch transport or update credentials — tested and applied here, no CLI needed
						</p>
					</div>
				</div>
				<UiButton v-if="!isEditing" variant="secondary" size="sm" @click="isEditing = true">
					<template #iconLeft><Icon name="lucide:settings-2" class="w-4 h-4" /></template>
					Edit transport
				</UiButton>
			</div>
		</template>

		<div v-if="isEditing" class="p-6 space-y-5">
			<fieldset class="space-y-2">
				<legend class="sr-only">Delivery provider</legend>
				<label
					v-for="opt in providerOptions"
					:key="opt.value"
					class="flex items-start gap-3 rounded-lg border p-4 cursor-pointer transition-colors"
					:class="
						provider === opt.value
							? 'border-brand ring-1 ring-brand bg-brand/5'
							: 'border-border-default hover:border-border-strong'
					"
				>
					<input
						v-model="provider"
						type="radio"
						:value="opt.value"
						class="mt-1 h-4 w-4 border-border-default bg-bg-deep text-brand focus-visible:ring-1 focus-visible:ring-brand"
					/>
					<UiIconBox
						:icon="opt.icon"
						size="sm"
						:variant="provider === opt.value ? 'brand' : 'surface'"
						rounded="lg"
					/>
					<div class="flex-1">
						<div class="font-medium text-text-primary">{{ opt.label }}</div>
						<div class="text-sm text-text-secondary">{{ opt.hint }}</div>
					</div>
				</label>
			</fieldset>

			<p class="text-xs text-text-tertiary flex items-center gap-1.5">
				<Icon name="lucide:shield" class="w-3.5 h-3.5" />
				Existing credentials are never shown. Re-enter them to change the transport.
			</p>

			<div v-if="provider === 'resend'">
				<UiInput
					v-model="resendKey"
					type="password"
					label="Resend API key"
					placeholder="re_..."
					autocomplete="off"
					:error="showErrors ? errors.resendKey : undefined"
				/>
			</div>

			<div v-if="provider === 'ses'" class="space-y-4">
				<UiInput v-model="sesRegion" label="Region" placeholder="us-east-1" />
				<UiInput v-model="sesAccess" label="Access key ID" autocomplete="off" />
				<UiInput v-model="sesSecret" type="password" label="Secret access key" autocomplete="off" />
				<p v-if="showErrors && errors.ses" class="text-sm text-error">{{ errors.ses }}</p>
			</div>

			<div v-if="provider === 'smtp'" class="space-y-4">
				<UiSelect v-model="smtpPreset" label="Provider preset" :options="smtpPresetOptions" />
				<UiInput
					v-model="smtpHost"
					label="Server host"
					placeholder="smtp.mailgun.org"
					autocomplete="off"
					:disabled="smtpPreset !== 'custom'"
				/>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<UiInput v-model="smtpPort" label="Port" placeholder="587" autocomplete="off" />
					<label
						class="flex items-center gap-3 rounded-lg border border-border-default p-3 cursor-pointer transition-colors hover:border-border-strong"
					>
						<input
							v-model="smtpSecure"
							type="checkbox"
							class="h-4 w-4 rounded border-border-default bg-bg-deep text-brand focus-visible:ring-1 focus-visible:ring-brand"
						/>
						<span class="text-sm text-text-secondary">
							Implicit TLS (port 465). Leave off for STARTTLS on 587.
						</span>
					</label>
				</div>
				<UiInput v-model="smtpUsername" label="Username" autocomplete="off" />
				<UiInput v-model="smtpPassword" type="password" label="Password" autocomplete="off" />
				<p v-if="showErrors && errors.smtp" class="text-sm text-error">{{ errors.smtp }}</p>
			</div>

			<div v-if="provider === 'mta'" class="space-y-3">
				<UiSelect
					v-model="outboundTlsMode"
					label="Connection security"
					:options="outboundTlsModeOptions"
				/>
				<p class="text-sm text-text-secondary">{{ outboundTlsModeHint }}</p>
				<p
					v-if="outboundTlsMode === 'require-verified'"
					class="text-xs text-warning flex items-start gap-1.5"
				>
					<Icon name="lucide:alert-circle" class="w-3.5 h-3.5 mt-0.5 shrink-0" />
					<span>
						“Always encrypt and verify” can bounce mail to receivers whose mail servers have a
						misconfigured or self-signed certificate. Use it only if you know your recipients keep
						valid certificates.
					</span>
				</p>
			</div>

			<div class="border-t border-border-subtle pt-5">
				<h3 class="font-medium text-text-primary">
					From identity <span class="text-sm font-normal text-text-tertiary">(optional)</span>
				</h3>
				<p class="text-sm text-text-secondary mb-3">
					Leave blank to keep the current default From address.
				</p>
				<div class="space-y-4">
					<UiInput
						v-model="fromEmail"
						type="email"
						label="Default From address"
						placeholder="noreply@yourdomain.com"
						autocomplete="off"
						:error="showErrors ? errors.fromEmail : undefined"
					/>
					<UiInput v-model="fromName" label="From name" placeholder="Owlat" autocomplete="off" />
				</div>
			</div>

			<!-- Test result -->
			<UiErrorAlert
				v-if="testResult"
				:variant="testResult.ok ? 'info' : 'error'"
				:title="testResult.ok ? 'Credentials verified' : 'Test failed'"
				:message="testResult.message"
			/>

			<p v-if="!canTest" class="text-xs text-text-tertiary flex items-center gap-1.5">
				<Icon name="lucide:info" class="w-3.5 h-3.5" />
				SES and your own MTA can't be tested before applying — apply, then use "Send a test email"
				below to confirm delivery.
			</p>

			<!-- Apply error / restart handoff -->
			<UiErrorAlert
				v-if="applyError"
				variant="error"
				title="Couldn't apply"
				:message="applyError"
			/>
			<UiErrorAlert
				v-if="restartNotice"
				variant="info"
				title="Restart required"
				:message="restartNotice"
			/>

			<!-- Actions -->
			<div class="flex flex-wrap items-center gap-3 border-t border-border-subtle pt-5">
				<UiButton
					v-if="canTest"
					variant="secondary"
					:loading="testing"
					:disabled="testing || applying"
					@click="handleTest"
				>
					<template v-if="!testing" #iconLeft>
						<Icon name="lucide:plug-zap" class="w-4 h-4" />
					</template>
					{{ testing ? 'Testing…' : 'Test credentials' }}
				</UiButton>
				<UiButton :loading="applying" :disabled="applying || testing" @click="handleApply">
					<template v-if="!applying" #iconLeft>
						<Icon name="lucide:check" class="w-4 h-4" />
					</template>
					{{ applying ? 'Applying…' : 'Apply transport' }}
				</UiButton>
				<UiButton variant="ghost" :disabled="applying || testing" @click="cancel">Cancel</UiButton>
			</div>
		</div>

		<div v-else class="px-6 py-5">
			<p class="text-sm text-text-secondary">
				The active transport is
				<span class="font-medium text-text-primary">{{ currentProvider ?? 'not set' }}</span
				>. Choose a different provider or rotate its credentials — the change is tested and applied
				in place.
			</p>
		</div>
	</UiCard>
</template>
