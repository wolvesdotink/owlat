/**
 * The ONE relay-credential draft, shared by the in-app transport editor
 * (`components/delivery/TransportEditor.vue`) and by step 1 of the transport
 * connection wizard (`components/delivery/TransportCredentialsStep.vue`).
 *
 * Both surfaces ask for the same three kinds of relay credential, validate them
 * with the same shipped validators, offer the same pre-apply live handshake and
 * write the same sealed env patch through the same endpoint. Holding that in one
 * place is not a tidiness exercise: two copies had already drifted apart in the
 * operator-facing provider hints, which is the failure mode this prevents.
 *
 * Values are WRITE-ONLY. They are never rendered back, never returned by the
 * server, and {@link RelayCredentialDraft.clearEnteredSecrets} drops them from
 * memory the moment a patch is accepted.
 */

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import {
	SMTP_RELAY_PRESETS,
	buildProviderEnv,
	type EmailStepDraft,
	type ProviderChoice,
	type SmtpPreset,
} from '~/composables/useSetupWizard';

/**
 * The transports you CONNECT. Derived from the shipped {@link ProviderChoice}
 * rather than re-declared, so a new relay kind reaches this list — and its
 * absence from the option table below becomes a compile error — instead of
 * silently going missing from both surfaces.
 */
export type RelayProviderChoice = Exclude<ProviderChoice, 'mta' | 'none'>;

export interface RelayProviderOption {
	readonly value: RelayProviderChoice;
	readonly label: string;
	readonly hint: string;
	readonly icon: string;
}

/** One copy of the operator-facing provider copy, in the shipped editor's order. */
export const RELAY_PROVIDER_OPTIONS: readonly RelayProviderOption[] = [
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
	{
		value: 'mandrill',
		label: 'Mailchimp Transactional (Mandrill)',
		hint: 'Arriving from Mailchimp? Keep sending on the reputation you already have, then let the ramp move traffic onto your own MTA.',
		icon: 'lucide:shuffle',
	},
];

/**
 * The in-app transport editor's picker: the relays above, plus the built-in MTA.
 *
 * The MTA is not a relay — it is the thing a relay is an alternative TO — so it
 * cannot live in `RELAY_PROVIDER_OPTIONS` (which types the connect-a-relay
 * surfaces). It sits here rather than in the editor component so the two lists
 * are declared in one file and a new relay kind reaches both by being added
 * once.
 */
export const TRANSPORT_EDITOR_PROVIDER_OPTIONS: readonly {
	readonly value: ProviderChoice;
	readonly label: string;
	readonly hint: string;
	readonly icon: string;
}[] = [
	{
		value: 'mta',
		label: 'Run your own MTA',
		hint: 'Full control, no third party. Needs port 25 open and a clean sending IP.',
		icon: 'lucide:server',
	},
	...RELAY_PROVIDER_OPTIONS,
];

/** The apply endpoint's contract, shared so both callers read the same fields. */
export interface ApplyTransportResponse {
	ok: boolean;
	message: string;
	applied: boolean;
	requiresRestart: boolean;
	/**
	 * The refusal the typed phrase clears, flagged rather than left to be read out
	 * of the message: the endpoint refuses fail-closed whenever it cannot
	 * establish that pulling the relay is safe, and a caller that renders that as
	 * an error string demands a phrase on a screen with nowhere to type it.
	 */
	needsRelayRemovalConfirmation?: true;
	/**
	 * The same consequence as `message`, minus its closing "type the phrase"
	 * sentence — the field a DIALOG renders, because the dialog states that
	 * instruction itself in the label of the input directly below the consequence.
	 */
	relayRemovalConsequence?: string;
}

/** The pre-apply live handshake's contract. */
export interface ValidateTransportResponse {
	ok: boolean;
	message: string;
}

/** The credential fields of an {@link EmailStepDraft} — everything but identity. */
export type RelayCredentialFields = Pick<
	EmailStepDraft,
	'resendKey' | 'mandrillKey' | 'ses' | 'smtp'
>;

export interface RelayCredentialDraft {
	readonly provider: Ref<ProviderChoice>;
	readonly resendKey: Ref<string>;
	readonly mandrillKey: Ref<string>;
	readonly sesRegion: Ref<string>;
	readonly sesAccess: Ref<string>;
	readonly sesSecret: Ref<string>;
	readonly smtpPreset: Ref<SmtpPreset>;
	readonly smtpHost: Ref<string>;
	readonly smtpPort: Ref<string>;
	readonly smtpSecure: Ref<boolean>;
	readonly smtpUsername: Ref<string>;
	readonly smtpPassword: Ref<string>;
	readonly smtpPresetOptions: { value: SmtpPreset; label: string }[];
	/** The credential half of the shipped draft shape. */
	readonly credentialFields: ComputedRef<RelayCredentialFields>;
	/** Every secret currently held in memory — the redaction list, in one place. */
	readonly enteredSecrets: ComputedRef<string[]>;
	/** Only Resend and SMTP have a pre-apply network handshake. */
	readonly canValidateLive: ComputedRef<boolean>;
	clearEnteredSecrets(): void;
	/** The shipped live handshake, or null when this kind has none. */
	validateLive(): Promise<ValidateTransportResponse | null>;
}

export function useRelayCredentialDraft(
	initialProvider: ProviderChoice = 'resend'
): RelayCredentialDraft {
	const provider = ref<ProviderChoice>(initialProvider);
	const resendKey = ref('');
	const mandrillKey = ref('');
	const sesRegion = ref('us-east-1');
	const sesAccess = ref('');
	const sesSecret = ref('');
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

	const credentialFields = computed<RelayCredentialFields>(() => ({
		resendKey: resendKey.value,
		mandrillKey: mandrillKey.value,
		ses: {
			region: sesRegion.value,
			accessKeyId: sesAccess.value,
			secretAccessKey: sesSecret.value,
		},
		smtp: {
			preset: smtpPreset.value,
			host: smtpHost.value,
			port: smtpPort.value,
			secure: smtpSecure.value,
			username: smtpUsername.value,
			password: smtpPassword.value,
		},
	}));

	const enteredSecrets = computed(() => [
		resendKey.value,
		mandrillKey.value,
		sesSecret.value,
		smtpPassword.value,
	]);

	// Mandrill sits with SES here, not with Resend: there is no pre-apply
	// handshake endpoint for it, and offering a check that always passes would be
	// worse than offering none. The transport wizard's live TEST SEND is the real
	// proof for both.
	const canValidateLive = computed(() => provider.value === 'resend' || provider.value === 'smtp');

	function clearEnteredSecrets(): void {
		resendKey.value = '';
		mandrillKey.value = '';
		sesSecret.value = '';
		smtpPassword.value = '';
	}

	async function validateLive(): Promise<ValidateTransportResponse | null> {
		if (!canValidateLive.value) return null;
		const trimmedPort = smtpPort.value.trim();
		const body =
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
		return await $fetch<ValidateTransportResponse>('/api/delivery/validate-transport', {
			method: 'POST',
			body,
		});
	}

	return {
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
		credentialFields,
		enteredSecrets,
		canValidateLive,
		clearEnteredSecrets,
		validateLive,
	};
}

/**
 * The sealed env patch, through the SHIPPED endpoint. The one place a credential
 * leaves the browser — the server allowlists the keys and seals the values, and
 * nothing it returns carries one back.
 *
 * `relayRemovalConfirmation` is the typed phrase, forwarded UNCHECKED: the
 * endpoint decides whether this change removes a relay cells are still leaning
 * on and whether the phrase matches, so a caller that never rendered the dialog
 * meets the same rule (`RELAY_REMOVAL_CONFIRMATION`) as one that did.
 */
export async function applyTransportEnv(
	draft: EmailStepDraft,
	relayRemovalConfirmation?: string
): Promise<ApplyTransportResponse> {
	// An empty base, so only the transport keys are sent; the backend allowlists
	// and clears the rest.
	const providerEnv = buildProviderEnv({}, draft);
	return await $fetch<ApplyTransportResponse>('/api/delivery/apply-transport', {
		method: 'POST',
		body: { providerEnv, relayRemovalConfirmation },
	});
}
