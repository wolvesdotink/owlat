<script setup lang="ts">
import {
	OUTBOUND_TLS_MODE_OPTIONS,
	seedOutboundTlsMode,
	type OutboundTlsMode,
} from '~/composables/setupOutboundTls';
import type { EmailStepDraft, ProviderChoice } from '~/composables/useSetupWizard';
import { transportStepIsValid, validateEmailStep } from '~/composables/setupWizardValidation';
import { RELAY_REMOVAL_CONFIRMATION } from '@owlat/shared/deliverabilityIndependence';
import {
	RELAY_PROVIDER_OPTIONS,
	TRANSPORT_EDITOR_PROVIDER_OPTIONS,
	applyTransportEnv,
	useRelayCredentialDraft,
} from '~/composables/useRelayCredentialDraft';
import { useRelayRemovalGuard } from '~/composables/useRelayRemovalGuard';

/**
 * In-app transport editor. Reuses the setup wizard's provider picker, SMTP
 * presets, live-handshake validation, and `buildProviderEnv` so an admin can
 * change the sending provider + credentials, TEST them, and APPLY them without
 * ever hand-editing `.env`. Existing secrets are NEVER shown — the credential
 * fields start blank, and applying re-enters them; the backend never returns a
 * value. Editing is an explicit action revealed behind "Change provider".
 *
 * ONE OF THESE CHANGES IS NOT LIKE THE OTHERS. Rotating a credential or moving
 * between two relays keeps a second arm; switching to the built-in MTA
 * DISCONNECTS the relay, and any cell the ramp has not graduated is still
 * sending part of its mail through it. That traffic does not move gently — it
 * all moves at once, which is the failure the ramp exists to avoid. So this
 * button opens the same consequence dialog the Independence screen opens, with
 * the same phrase, and the endpoint re-checks the phrase server-side: the dialog
 * is what an operator sees, not what makes the change safe.
 *
 * THE SERVER'S REFUSAL OPENS THE SAME DIALOG. This screen's removal read can be
 * unresolved (Apply pressed early) or faulted, and both leave it unable to tell
 * that a removal is unsafe — so the endpoint refuses fail-closed, and that
 * refusal is a request for the phrase rather than an error. It is routed to the
 * dialog on the `needsRelayRemovalConfirmation` flag, never printed: a rule an
 * operator is given no way to meet is a dead end, not a safeguard. Its SENTENCE
 * travels with it — the endpoint's read is a different read from this screen's,
 * and on that path it is the only one that knows how many cells are still
 * leaning on the relay and what date waiting would make it free.
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
// Derived from the shared relay list rather than re-spelling the union: a kind
// added there is seedable here without an edit, and an unknown/retired kind
// still falls back to the MTA rather than to a transport this build cannot
// render fields for.
function knownKind(kind: string | null): ProviderChoice {
	if (kind === 'mta') return 'mta';
	return RELAY_PROVIDER_OPTIONS.find((option) => option.value === kind)?.value ?? 'mta';
}

// The SAME relay-credential draft the connection wizard's step 1 uses — one
// provider list, one preset table, one live handshake, one env patch.
const relay = useRelayCredentialDraft(knownKind(props.currentProvider));
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
	smtpSecure,
	smtpUsername,
	smtpPassword,
	smtpPresetOptions,
} = relay;

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

const providerOptions = TRANSPORT_EDITOR_PROVIDER_OPTIONS;

const draft = computed<EmailStepDraft>(() => ({
	provider: provider.value,
	// The editor only ever sets a real transport, so the "none" branch of the
	// shared validator is unreachable here.
	requiresProvider: true,
	...relay.credentialFields.value,
	outboundTlsMode: outboundTlsMode.value,
	fromEmail: fromEmail.value,
	fromName: fromName.value,
}));

const submitted = ref(false);
const errors = computed(() => validateEmailStep(draft.value));
const showErrors = computed(() => submitted.value);

/**
 * ONE OF THE WIZARD'S RULES IS NOT THIS SCREEN'S — decided in
 * `setupWizardValidation`, beside the rules themselves, rather than by listing here the
 * one key to ignore. `transportStepIsValid` names the errors a transport-only
 * screen OWNS and is exhaustive over `EmailStepErrors`, so the next field that
 * step gains must be classified there instead of silently gating this Apply
 * button on a field this screen does not render.
 */
const isValid = computed(() => transportStepIsValid(draft.value));

// Only Resend + SMTP have a pre-apply network handshake (the wizard is the same).
const canTest = relay.canValidateLive;

// ── Test ─────────────────────────────────────────────────────────────────────
const testing = ref(false);
const testResult = ref<{ ok: boolean; message: string } | null>(null);

async function handleTest() {
	submitted.value = true;
	testResult.value = null;
	if (!isValid.value) return;
	testing.value = true;
	try {
		testResult.value = await relay.validateLive();
	} catch (e) {
		testResult.value = {
			ok: false,
			message: (e as Error).message || 'Could not reach the provider. Try again.',
		};
	} finally {
		testing.value = false;
	}
}

// ── Disconnecting the relay ──────────────────────────────────────────────────
/**
 * The removal-safety read + the consequence sentence, in the shared guard: the
 * Independence screen asks the same question of the same query, so the screen
 * that WARNS and the screen that CHANGES cannot disagree about which cells are
 * still leaning on the relay.
 */
const { removesReferenceArm, removalConsequence, dialogConsequence, noteServerRefusal } =
	useRelayRemovalGuard(provider);

const isRemovalDialogOpen = ref(false);

// ── Apply ────────────────────────────────────────────────────────────────────
const applying = ref(false);
const applyError = ref('');
const restartNotice = ref('');

function handleApply(): Promise<void> | void {
	submitted.value = true;
	applyError.value = '';
	restartNotice.value = '';
	if (!isValid.value) return;
	// NOTHING IS SENT YET. The button opens the dialog; only the typed phrase
	// applies the change.
	if (removesReferenceArm.value) {
		isRemovalDialogOpen.value = true;
		return;
	}
	return apply();
}

function confirmRelayRemoval(confirmation: string): Promise<void> {
	isRemovalDialogOpen.value = false;
	return apply(confirmation);
}

async function apply(relayRemovalConfirmation?: string): Promise<void> {
	applying.value = true;
	noteServerRefusal(null);
	try {
		// The wizard's env patch, literally: one helper, one endpoint.
		const res = await applyTransportEnv(draft.value, relayRemovalConfirmation);
		if (!res.ok) {
			// A FAIL-CLOSED REFUSAL IS NOT AN ERROR MESSAGE. The endpoint demands the
			// phrase whenever it cannot establish that the removal is safe — which
			// includes every apply made before this screen's own removal read
			// resolved, and every apply made after it faulted. Rendering that under
			// "Couldn't apply" left the operator reading "type REMOVE THE RELAY" on a
			// screen with nowhere to type it, so the refusal opens the dialog instead.
			if (res.needsRelayRemovalConfirmation === true) {
				// Its consequence is the SHARED sentence, built from the read this
				// browser could not make — so it is carried into the dialog rather than
				// discarded with the response. THE CONSEQUENCE FIELD, NOT THE MESSAGE:
				// the message closes with "type REMOVE THE RELAY to disconnect it
				// anyway", which this dialog then states again in the label of its own
				// input, directly below. The message is only the fallback for a refusal
				// that carries no separate consequence.
				noteServerRefusal(res.relayRemovalConsequence ?? res.message);
				isRemovalDialogOpen.value = true;
				return;
			}
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
		relay.clearEnteredSecrets();
		emit('applied');
	} catch (e) {
		applyError.value = (e as Error).message || 'Could not apply the transport. Try again.';
	} finally {
		applying.value = false;
	}
}

function cancel() {
	isEditing.value = false;
	isRemovalDialogOpen.value = false;
	submitted.value = false;
	testResult.value = null;
	applyError.value = '';
	restartNotice.value = '';
	noteServerRefusal(null);
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

			<div v-if="provider === 'mandrill'" class="space-y-3">
				<UiInput
					v-model="mandrillKey"
					type="password"
					label="Mailchimp Transactional API key"
					placeholder="md-..."
					autocomplete="off"
					:error="showErrors ? errors.mandrillKey : undefined"
				/>
				<p class="text-xs text-text-tertiary">
					Mailchimp Transactional &rarr; Settings &rarr; API keys. Feedback needs a second variable,
					<code class="text-text-primary">MANDRILL_WEBHOOK_KEY</code> — the webhook card below has
					the URL and the events to enable.
				</p>
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
				SES, Mailchimp Transactional and your own MTA can't be tested before applying — apply, then
				use "Send a test email" below to confirm delivery.
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

			<!-- The one transport change that can lose reputation names what it costs. -->
			<DeliveryRampConfirmDialog
				:open="isRemovalDialogOpen"
				title="Disconnect the relay?"
				:phrase="RELAY_REMOVAL_CONFIRMATION"
				confirm-label="Disconnect and switch to my own MTA"
				:busy="applying"
				@cancel="isRemovalDialogOpen = false"
				@confirm="confirmRelayRemoval"
			>
				<template #consequence>
					<p data-testid="transport-removal-consequence">{{ dialogConsequence }}</p>
					<p v-if="removalConsequence.safeDate !== null" data-testid="transport-removal-dialog-date">
						{{ removalConsequence.safeDate }}
					</p>
				</template>
			</DeliveryRampConfirmDialog>
		</div>

		<div v-else class="px-6 py-5">
			<p class="text-sm text-text-secondary">
				The active transport is
				<span class="font-medium text-text-primary">{{ currentProvider ?? 'not set' }}</span
				>. Choose a different provider or rotate its credentials — the change is tested and applied
				in place.
			</p>
			<!-- One endpoint, two doors: name the relationship so neither affordance
			     looks like it does something the other does not. -->
			<p class="text-sm text-text-secondary mt-2">
				“Connect an email provider” below is the guided version of this: the same change, walked
				step by step with a live send test and DNS alignment checks.
			</p>
		</div>
	</UiCard>
</template>
