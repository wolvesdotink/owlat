<script setup lang="ts">
/**
 * Step 1 of the transport connection wizard: CREDENTIALS (P2-4).
 *
 * Split out of `TransportConnectionWizard.vue` at the repo's ~500-LOC cap, and
 * along the right seam: this component owns the credential DRAFT and nothing
 * else knows it exists. The wizard shell only learns whether the step settled.
 *
 * The path is the SHIPPED one (D4 — no second credential model): the setup
 * wizard's validators and `buildProviderEnv`, applied through the sealed
 * `/api/delivery/apply-transport` env patch that `TransportEditor.vue` already
 * uses. Values are WRITE-ONLY — never rendered back, never logged, dropped from
 * memory the moment the patch is accepted, and redacted out of any provider
 * error text before it can reach the screen or a console.
 */
import { computed, ref, watch } from 'vue';
import {
	SMTP_RELAY_PRESETS,
	buildProviderEnv,
	emailStepIsValid,
	validateEmailStep,
	type EmailStepDraft,
	type SmtpPreset,
} from '~/composables/useSetupWizard';
import { redactSecrets } from '~/utils/transportWizard';

/**
 * `settled` carries the outcome the wizard gates on; `applied` is the shipped
 * "a transport changed, refetch status" signal the page already listens for.
 * Neither carries a credential.
 */
const emit = defineEmits<{ settled: [{ ok: boolean }]; applied: [] }>();

/** The MTA is not a thing you connect here — this step is for relays only. */
type WizardProvider = 'resend' | 'ses' | 'smtp';

const provider = ref<WizardProvider>('resend');
const resendKey = ref('');
const sesRegion = ref('us-east-1');
const sesAccess = ref('');
const sesSecret = ref('');
const smtpPreset = ref<SmtpPreset>('mailgun');
const smtpHost = ref(SMTP_RELAY_PRESETS['mailgun'].host);
const smtpPort = ref(SMTP_RELAY_PRESETS['mailgun'].port);
const smtpSecure = ref(SMTP_RELAY_PRESETS['mailgun'].secure);
const smtpUsername = ref('');
const smtpPassword = ref('');

const providerOptions: { value: WizardProvider; label: string; hint: string }[] = [
	{ value: 'resend', label: 'Resend', hint: 'Managed API with a generous free tier.' },
	{ value: 'ses', label: 'Amazon SES', hint: 'Cheap at scale. Needs an AWS account.' },
	{ value: 'smtp', label: 'SMTP relay', hint: 'Mailgun, Postmark, SendGrid, Brevo, or custom.' },
];

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

/** Every secret currently held in memory — the redaction list, in one place. */
const enteredSecrets = computed(() => [resendKey.value, sesSecret.value, smtpPassword.value]);

const draft = computed<EmailStepDraft>(() => ({
	provider: provider.value,
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
	fromEmail: '',
	fromName: '',
}));

const submitted = ref(false);
const errors = computed(() => validateEmailStep(draft.value));
const showErrors = computed(() => submitted.value);
const credentialError = ref('');
const restartNotice = ref('');
const applying = ref(false);

/** Never surface a provider's message verbatim — it can quote the key back. */
function fail(raw: string) {
	credentialError.value = redactSecrets(raw, enteredSecrets.value);
	emit('settled', { ok: false });
}

function clearEnteredSecrets() {
	resendKey.value = '';
	sesSecret.value = '';
	smtpPassword.value = '';
}

async function applyCredentials() {
	submitted.value = true;
	credentialError.value = '';
	restartNotice.value = '';
	if (!emailStepIsValid(draft.value)) return;
	applying.value = true;
	try {
		const providerEnv = buildProviderEnv({}, draft.value);
		const res = await $fetch<{
			ok: boolean;
			message: string;
			applied: boolean;
			requiresRestart: boolean;
		}>('/api/delivery/apply-transport', { method: 'POST', body: { providerEnv } });
		if (!res.ok) {
			fail(res.message);
			return;
		}
		if (res.requiresRestart) restartNotice.value = res.message;
		// Write-only: the values left with the sealed patch and are dropped here.
		clearEnteredSecrets();
		emit('settled', { ok: true });
		emit('applied');
	} catch (e) {
		fail((e as Error).message || 'Could not apply the transport. Try again.');
	} finally {
		applying.value = false;
	}
}
</script>

<template>
	<div class="space-y-4">
		<fieldset class="space-y-2">
			<legend class="text-sm font-medium text-text-primary">Provider</legend>
			<label
				v-for="opt in providerOptions"
				:key="opt.value"
				class="flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors"
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
					class="mt-1 h-4 w-4 border-border-default bg-bg-deep text-brand"
				/>
				<span>
					<span class="block font-medium text-text-primary">{{ opt.label }}</span>
					<span class="block text-sm text-text-secondary">{{ opt.hint }}</span>
				</span>
			</label>
		</fieldset>

		<p class="text-xs text-text-tertiary">
			Credentials are sealed on the server. They are never shown again and never returned to this
			screen.
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

		<div v-if="provider === 'ses'" class="space-y-3">
			<UiInput v-model="sesRegion" label="Region" placeholder="us-east-1" />
			<UiInput v-model="sesAccess" label="Access key ID" autocomplete="off" />
			<UiInput v-model="sesSecret" type="password" label="Secret access key" autocomplete="off" />
			<p v-if="showErrors && errors.ses" class="text-sm text-error">{{ errors.ses }}</p>
		</div>

		<div v-if="provider === 'smtp'" class="space-y-3">
			<UiSelect v-model="smtpPreset" label="Provider preset" :options="smtpPresetOptions" />
			<UiInput
				v-model="smtpHost"
				label="Server host"
				autocomplete="off"
				:disabled="smtpPreset !== 'custom'"
			/>
			<UiInput v-model="smtpPort" label="Port" placeholder="587" autocomplete="off" />
			<UiInput v-model="smtpUsername" label="Username" autocomplete="off" />
			<UiInput v-model="smtpPassword" type="password" label="Password" autocomplete="off" />
			<p v-if="showErrors && errors.smtp" class="text-sm text-error">{{ errors.smtp }}</p>
		</div>

		<div v-if="credentialError" role="alert">
			<UiErrorAlert variant="error" title="Couldn't apply" :message="credentialError" />
		</div>
		<UiErrorAlert
			v-if="restartNotice"
			variant="info"
			title="Restart required"
			:message="restartNotice"
		/>

		<UiButton :loading="applying" :disabled="applying" @click="applyCredentials">
			{{ applying ? 'Applying…' : 'Save credentials' }}
		</UiButton>
	</div>
</template>
