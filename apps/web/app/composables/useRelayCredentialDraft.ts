/**
 * The ONE relay-credential draft, shared by the in-app transport editor
 * (`components/delivery/TransportEditor.vue`) and by step 1 of the transport
 * connection wizard (`components/delivery/TransportCredentialsStep.vue`).
 *
 * Both surfaces ask for the same relay credentials, validate them with the same
 * shipped validators, offer the same pre-apply live handshake and write the same
 * sealed env patch through the same endpoint. Holding that in one place is not a
 * tidiness exercise: two copies had already drifted apart in the operator-facing
 * provider hints, which is the failure mode this prevents.
 *
 * IT NO LONGER KNOWS ANY PROVIDER (the seams plan's D5). The draft used to hold
 * one named ref per vendor field (`resendKey`, `sesRegion`, `smtpHost`, …), a
 * hand-written option table, and two `provider === '<kind>'` questions. It now
 * holds ONE map keyed by deployment env variable, seeded and rendered from the
 * catalog's `credentialFields` descriptors, and asks the catalog which kinds can
 * be checked before they are applied. Adding a provider adds nothing here.
 *
 * Values are WRITE-ONLY. They are never rendered back, never returned by the
 * server, and {@link RelayCredentialDraft.clearEnteredSecrets} drops them from
 * memory the moment a patch is accepted — for every `secret` field the catalog
 * declares, so a new provider's key is covered by the same rule rather than by
 * remembering to add it to a list.
 */

import { computed, reactive, ref, watch, type ComputedRef, type Ref } from 'vue';
import {
	CORE_SEND_PROVIDER_CATALOG_ENTRIES,
	OWN_SEND_PROVIDER_KIND,
	SEND_TRANSPORT_KINDS,
	coreSendProviderCatalogEntry,
	isOwnSendProviderKind,
	type OwnSendProviderKind,
} from '@owlat/shared/sendProviderCatalog';
import {
	draftCredentialsFromValues,
	firstPreset,
	hostPortFieldFor,
	seedCredentialValues,
	secretEnvKeys,
	type DraftCredentials,
	type TransportCredentialValues,
} from '~/composables/setupWizardCredentials';
import {
	buildProviderEnv,
	type EmailStepDraft,
	type ProviderChoice,
	type SmtpPreset,
} from '~/composables/useSetupWizard';

/**
 * The transports you CONNECT: every catalog kind except the own arm (D3's one
 * legitimate identity — a relay is what the own MTA is an alternative TO) and
 * except the receive-only answer, which is not a transport at all.
 */
export type RelayProviderChoice = Exclude<ProviderChoice, OwnSendProviderKind | 'none'>;

export interface RelayProviderOption {
	readonly value: RelayProviderChoice;
	readonly label: string;
	readonly hint: string;
	readonly icon: string;
}

/**
 * The picker's COPY — one sentence and one icon per transport, in the order the
 * shipped screens list them.
 *
 * Deliberately not in the catalog, which states so itself: a descriptor carries
 * the label a form needs, and "hints, icons and per-vendor prose" stay where the
 * copy is written. What is NOT here any more is the label and the kind list —
 * both are read from the catalog below, so this table can only ever ADD copy to
 * a provider that already exists.
 *
 * A kind with no row still appears, with the catalog's label, a neutral icon and
 * no sentence: a provider must never be missing from the picker because nobody
 * wrote a hint for it. Rows in this table lead, in their order (which is the
 * order the four incumbents have always been shown in — deliberately not catalog
 * order, which would reorder a shipped form); anything else follows in catalog
 * order.
 */
const TRANSPORT_PICKER_COPY: readonly { kind: string; hint: string; icon: string }[] = [
	{
		kind: OWN_SEND_PROVIDER_KIND,
		hint: 'Full control, no third party. Needs port 25 open and a clean sending IP.',
		icon: 'lucide:server',
	},
	{
		kind: 'ses',
		hint: 'Managed deliverability, cheap at scale. Needs an AWS account.',
		icon: 'lucide:cloud',
	},
	{
		kind: 'smtp',
		hint: 'Mailgun, Postmark, SendGrid, Brevo, or any custom SMTP server.',
		icon: 'lucide:route',
	},
	{ kind: 'resend', hint: 'Managed API with a generous free tier.', icon: 'lucide:zap' },
	{
		kind: 'mandrill',
		hint: 'Arriving from Mailchimp? Keep sending on the reputation you already have, then let the ramp move traffic onto your own MTA.',
		icon: 'lucide:shuffle',
	},
];

/** The catalog's kinds, ordered by the copy table above and then by the catalog. */
function pickerOrderedKinds(): readonly string[] {
	const copyOrder = TRANSPORT_PICKER_COPY.map((row) => row.kind).filter((kind) =>
		SEND_TRANSPORT_KINDS.includes(kind as never)
	);
	return [...copyOrder, ...SEND_TRANSPORT_KINDS.filter((kind) => !copyOrder.includes(kind))];
}

function pickerOption(kind: string): RelayProviderOption {
	const copy = TRANSPORT_PICKER_COPY.find((row) => row.kind === kind);
	return {
		value: kind as RelayProviderChoice,
		label: coreSendProviderCatalogEntry(kind)?.label ?? kind,
		hint: copy?.hint ?? '',
		icon: copy?.icon ?? 'lucide:send',
	};
}

/** One copy of the operator-facing relay copy, in the shipped editor's order. */
export const RELAY_PROVIDER_OPTIONS: readonly RelayProviderOption[] = pickerOrderedKinds()
	.filter((kind) => !isOwnSendProviderKind(kind))
	.map(pickerOption);

/**
 * The in-app transport editor's picker: the relays above, plus the built-in MTA.
 *
 * The MTA is not a relay — it is the thing a relay is an alternative TO — so it
 * cannot live in `RELAY_PROVIDER_OPTIONS` (which types the connect-a-relay
 * surfaces). It leads this list because the own arm is the deployment's default
 * answer, which is exactly what `tier: 'own'` declares.
 */
export const TRANSPORT_EDITOR_PROVIDER_OPTIONS: readonly {
	readonly value: ProviderChoice;
	readonly label: string;
	readonly hint: string;
	readonly icon: string;
}[] = [pickerOption(OWN_SEND_PROVIDER_KIND), ...RELAY_PROVIDER_OPTIONS];

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
export type RelayCredentialFields = DraftCredentials;

/**
 * THE PRE-APPLY HANDSHAKE'S REQUEST SHAPE, per probe.
 *
 * Which kinds can be checked before they are applied is the CATALOG's answer
 * (`setupProbe` — absent for SES, Mandrill and our own MTA, whose real proof is
 * the live send test after applying). What the check has to SEND is the shipped
 * endpoint's contract, and `/api/delivery/validate-transport` still takes one
 * hand-shaped body per probe. So the body builders are keyed by the probe's own
 * `validator` name — never by the provider kind — and a probe with no builder
 * here reads as "cannot be checked", which is the fail-closed answer rather than
 * a request the endpoint would reject.
 *
 * This table is the browser half of the descriptor rollout the seams plan leaves
 * outside `apps/web/app/**` (the CLI prompts, the two validate endpoints and
 * `setupValidators.ts`); when that endpoint takes descriptor values directly,
 * this collapses into one generic body.
 */
const PROBE_REQUEST_BODIES: Record<
	string,
	(values: TransportCredentialValues) => Record<string, unknown>
> = {
	validateResendKey: (values) => ({ apiKey: values['RESEND_API_KEY'] ?? '' }),
	validateSmtpRelay: (values) => {
		const port = (values['SMTP_RELAY_PORT'] ?? '').trim();
		return {
			smtp: {
				host: (values['SMTP_RELAY_HOST'] ?? '').trim(),
				port: port ? Number.parseInt(port, 10) : 587,
				secure: values['SMTP_RELAY_SECURE'] === 'true',
				username: values['SMTP_RELAY_USERNAME'] ?? '',
				password: values['SMTP_RELAY_PASSWORD'] ?? '',
			},
		};
	},
};

export interface RelayCredentialDraft {
	readonly provider: Ref<ProviderChoice>;
	/**
	 * Every credential the form holds, keyed by the deployment variable it will be
	 * written to. The generic field renderer reads and writes this map directly;
	 * nothing else needs to know which key belongs to which provider.
	 */
	readonly credentialValues: TransportCredentialValues;
	/** Which well-known endpoint a `host-port` field is prefilled from. */
	readonly preset: Ref<SmtpPreset>;
	readonly presetOptions: ComputedRef<{ value: SmtpPreset; label: string }[]>;
	/** The credential half of the shipped draft shape. */
	readonly credentialFields: ComputedRef<RelayCredentialFields>;
	/** Every secret currently held in memory — the redaction list, in one place. */
	readonly enteredSecrets: ComputedRef<string[]>;
	/** True only for a kind whose catalog entry declares a pre-apply probe. */
	readonly canValidateLive: ComputedRef<boolean>;
	clearEnteredSecrets(): void;
	/** The shipped live handshake, or null when this kind has none. */
	validateLive(): Promise<ValidateTransportResponse | null>;
}

/** The blank form for every kind at once, so switching provider keeps input. */
function seedAllCredentialValues(): TransportCredentialValues {
	const values: TransportCredentialValues = {};
	for (const entry of CORE_SEND_PROVIDER_CATALOG_ENTRIES) {
		Object.assign(values, seedCredentialValues(entry.kind));
	}
	return values;
}

/** The preset a `host-port` field starts on: the first the descriptor offers. */
function seedPreset(): SmtpPreset {
	for (const entry of CORE_SEND_PROVIDER_CATALOG_ENTRIES) {
		const field = hostPortFieldFor(entry.kind);
		const preset = field === undefined ? undefined : firstPreset(field);
		if (preset !== undefined) return preset.key;
	}
	return 'custom';
}

export function useRelayCredentialDraft(
	initialProvider: ProviderChoice = 'resend'
): RelayCredentialDraft {
	const provider = ref<ProviderChoice>(initialProvider);
	const credentialValues = reactive<TransportCredentialValues>(seedAllCredentialValues());
	const preset = ref<SmtpPreset>(seedPreset());

	const hostPortField = computed(() => hostPortFieldFor(provider.value));

	const presetOptions = computed(() =>
		Object.entries(hostPortField.value?.presets ?? {}).map(([key, config]) => ({
			value: key as SmtpPreset,
			label: config.label,
		}))
	);

	// Choosing a named preset prefills host/port/TLS; Custom leaves them editable.
	watch(preset, (chosen) => {
		const field = hostPortField.value;
		const config = field?.presets?.[chosen];
		if (field === undefined || config === undefined || config.host === '') return;
		credentialValues[field.envVar] = config.host;
		credentialValues[field.portEnvVar] = config.port;
		credentialValues[field.secureEnvVar] = String(config.secure);
	});

	const credentialFields = computed<RelayCredentialFields>(() =>
		draftCredentialsFromValues({ ...credentialValues }, preset.value)
	);

	// Every `secret` field the catalog declares, across every kind: the draft can
	// hold a key for a provider the operator moved away from, and the redaction
	// list has to cover it.
	const secretKeys = secretEnvKeys(CORE_SEND_PROVIDER_CATALOG_ENTRIES.map((entry) => entry.kind));

	const enteredSecrets = computed(() => secretKeys.map((key) => credentialValues[key] ?? ''));

	const activeProbe = computed(() => coreSendProviderCatalogEntry(provider.value)?.setupProbe);

	const canValidateLive = computed(() => {
		const validator = activeProbe.value?.validator;
		return validator !== undefined && validator in PROBE_REQUEST_BODIES;
	});

	function clearEnteredSecrets(): void {
		for (const key of secretKeys) credentialValues[key] = '';
	}

	async function validateLive(): Promise<ValidateTransportResponse | null> {
		const validator = activeProbe.value?.validator;
		const buildBody = validator === undefined ? undefined : PROBE_REQUEST_BODIES[validator];
		if (buildBody === undefined) return null;
		return await $fetch<ValidateTransportResponse>('/api/delivery/validate-transport', {
			method: 'POST',
			body: { provider: provider.value, ...buildBody({ ...credentialValues }) },
		});
	}

	return {
		provider,
		credentialValues,
		preset,
		presetOptions,
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
