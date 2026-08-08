<script setup lang="ts">
/**
 * Step 1 of the transport connection wizard: CREDENTIALS (P2-4).
 *
 * Split out of `TransportConnectionWizard.vue` at the repo's ~500-LOC cap, and
 * along the right seam: this component owns the credential DRAFT and nothing
 * else knows it exists. The wizard shell only learns whether the step settled.
 *
 * The path is the SHIPPED one (D4 — no second credential model): the relay
 * credential draft, validators and live handshake `TransportEditor.vue` uses
 * (`useRelayCredentialDraft`), applied through the sealed
 * `/api/delivery/apply-transport` env patch. Values are WRITE-ONLY — never
 * rendered back, never logged, dropped from memory the moment the patch is
 * accepted, and redacted out of any provider text before it can reach the screen
 * or a console.
 *
 * WHAT APPLYING DOES, stated plainly here and in the step's copy: the shipped
 * env patch REPOINTS the deployment's default transport at the provider you
 * enter. Owlat sends through it from that moment, and the built-in MTA stops
 * being the default sender until you change it back under "Change provider".
 * This wizard is the guided version of that same action, against the same
 * endpoint — it does not add a second transport alongside the first. Splitting
 * traffic between two arms is the ramp controller's job and lands with it; until
 * then the honest description of this button is "switch", not "split", and the
 * operator is told so before they press it.
 */
import { computed, ref } from 'vue';
import type { EmailStepDraft } from '~/composables/useSetupWizard';
import { emailStepIsValid, validateEmailStep } from '~/composables/setupWizardValidation';
import {
	RELAY_PROVIDER_OPTIONS,
	applyTransportEnv,
	useRelayCredentialDraft,
	type ValidateTransportResponse,
} from '~/composables/useRelayCredentialDraft';
import { redactSecrets } from '~/utils/transportWizard';

/**
 * `settled` carries the outcome the wizard gates on; `applied` is the shipped
 * "a transport changed, refetch status" signal the page already listens for.
 * Neither carries a credential.
 */
const emit = defineEmits<{ settled: [{ ok: boolean }]; applied: [] }>();

const relay = useRelayCredentialDraft('resend');
const {
	provider,
	resendKey,
	mandrillKey,
	sesRegion,
	sesAccess,
	sesSecret,
	smtpPreset,
	smtpHost,
	smtpPort,
	smtpUsername,
	smtpPassword,
	smtpPresetOptions,
	enteredSecrets,
	canValidateLive,
} = relay;

const providerOptions = RELAY_PROVIDER_OPTIONS;

const draft = computed<EmailStepDraft>(() => ({
	provider: provider.value,
	requiresProvider: true,
	...relay.credentialFields.value,
	fromEmail: '',
	fromName: '',
}));

const submitted = ref(false);
const errors = computed(() => validateEmailStep(draft.value));
const showErrors = computed(() => submitted.value);
const credentialError = ref('');
const restartNotice = ref('');
const validationResult = ref<ValidateTransportResponse | null>(null);
const applying = ref(false);

/**
 * The redaction boundary. EVERY operator-facing string this component renders
 * goes through here — a provider's own message can quote back the key it
 * rejected, and an unhandled `Error` can carry a request body.
 */
function safe(raw: string): string {
	return redactSecrets(raw, enteredSecrets.value);
}

function fail(raw: string) {
	credentialError.value = safe(raw);
	emit('settled', { ok: false });
}

async function applyCredentials() {
	submitted.value = true;
	credentialError.value = '';
	restartNotice.value = '';
	validationResult.value = null;
	if (!emailStepIsValid(draft.value)) return;
	applying.value = true;
	try {
		// The SHIPPED pre-apply handshake first (Resend and SMTP have one), so a bad
		// key is named by the provider here rather than discovered at the live send
		// test — after the deployment's transport has already been repointed.
		const validated = await relay.validateLive();
		if (validated !== null) {
			validationResult.value = { ok: validated.ok, message: safe(validated.message) };
			if (!validated.ok) {
				emit('settled', { ok: false });
				return;
			}
		}
		const res = await applyTransportEnv(draft.value);
		if (!res.ok) {
			fail(res.message);
			return;
		}
		if (res.requiresRestart) restartNotice.value = safe(res.message);
		// Write-only: the values left with the sealed patch and are dropped here.
		relay.clearEnteredSecrets();
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

		<!-- The consequence, before the button that causes it. This is the guided
		     version of "Change provider": it repoints the deployment's default
		     transport at this provider, so Owlat sends through it and your own
		     server stops being the default sender until you switch back. -->
		<p class="text-sm text-text-secondary">
			Saving makes this provider the transport Owlat sends through. Your own server keeps running
			and stays one switch away under “Change provider”, but it stops being the default sender until
			you switch back.
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

		<div v-if="provider === 'mandrill'" class="space-y-3" data-testid="mandrill-credentials">
			<UiInput
				v-model="mandrillKey"
				type="password"
				label="Mailchimp Transactional API key"
				placeholder="md-..."
				autocomplete="off"
				:error="showErrors ? errors.mandrillKey : undefined"
			/>
			<p class="text-xs text-text-tertiary">
				Mailchimp Transactional &rarr; Settings &rarr; API keys. Feedback (bounces, complaints,
				rejects) needs a second variable, <code>MANDRILL_WEBHOOK_KEY</code>, which Mandrill issues
				when you create the webhook — the delivery page has the URL and the event list.
			</p>
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

		<p v-if="!canValidateLive" class="text-xs text-text-tertiary">
			Amazon SES and Mailchimp Transactional can’t be checked before applying — the live send test in
			the next step confirms it.
		</p>

		<div v-if="validationResult && !validationResult.ok" role="alert">
			<UiErrorAlert variant="error" title="Test failed" :message="validationResult.message" />
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
