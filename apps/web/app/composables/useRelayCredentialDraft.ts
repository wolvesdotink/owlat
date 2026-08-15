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
	OWN_SEND_PROVIDER_KIND,
	isOwnSendProviderKind,
	type OwnSendProviderKind,
	type SendProviderHostPortField,
} from '@owlat/shared/sendProviderCatalog';
import {
	draftCredentialsFromValues,
	firstPreset,
	hostPortFieldFor,
	seedCredentialValues,
	secretEnvKeys,
	requiredCredentialError,
	type DraftCredentials,
	type MissingCredentialMessage,
	type TransportCredentialValues,
} from '~/composables/setupWizardCredentials';
import {
	buildProviderEnv,
	type EmailStepDraft,
	type ProviderChoice,
	type SmtpPreset,
} from '~/composables/useSetupWizard';
import {
	COMPOSED_SEND_PROVIDER_CATALOG_ENTRIES,
	COMPOSED_SEND_TRANSPORT_KINDS,
	composedSendProviderCatalogEntry,
} from '~/utils/composedSendProviderCatalog';

/**
 * The transports you CONNECT: every catalog kind except the own arm (D3's one
 * legitimate identity — a relay is what the own MTA is an alternative TO) and
 * except the receive-only answer, which is not a transport at all.
 */
export type RelayProviderChoice = Exclude<ProviderChoice, OwnSendProviderKind | 'none'>;

export interface RelayProviderOption {
	readonly value: RelayProviderChoice;
	/** i18n message key (or the catalog's own label) — resolve with `t()`. */
	readonly label: string;
	/** i18n message key — resolve with `t()`; empty when the kind has no copy. */
	readonly hint: string;
	readonly icon: string;
}

/**
 * The picker's COPY — one sentence and one icon per transport, in the order the
 * shipped screens list them. `label` and `hint` are i18n MESSAGE KEYS, because
 * this table is built at module scope, before any component sets up: the screens
 * that render an option resolve them with `t(option.label)` / `t(option.hint)`.
 *
 * Deliberately not in the catalog, which states so itself: a descriptor carries
 * the label a form needs, and "hints, icons and per-vendor prose" stay where the
 * copy is written. What is NOT here any more is the KIND LIST — it is read from
 * the catalog below, so this table can only ever ADD copy to a provider that
 * already exists, and the one `label` it still carries is the own arm's (see
 * that row).
 *
 * A kind with no row still appears, with the catalog's label, a neutral icon and
 * no sentence: a provider must never be missing from the picker because nobody
 * wrote a hint for it. Rows in this table lead, in their order (which is the
 * order the four incumbents have always been shown in — deliberately not catalog
 * order, which would reorder a shipped form); anything else follows in catalog
 * order.
 */
const TRANSPORT_PICKER_COPY: readonly {
	kind: string;
	hint: string;
	icon: string;
	label?: string;
}[] = [
	{
		kind: OWN_SEND_PROVIDER_KIND,
		// THE ONE `label` OVERRIDE, and it is on the one kind D3 calls special by
		// definition: this picker's own-arm option is an INSTRUCTION ("Run your own
		// MTA"), not the transport's name, and it is what the shipped editor says.
		// Every relay takes the catalog's label — none of the four incumbents
		// needed an override, and a new provider cannot need one either, because
		// the fallback is the entry's own label.
		label: 'shared.useRelayCredentialDraft.providers.mta.label',
		hint: 'shared.useRelayCredentialDraft.providers.mta.hint',
		icon: 'lucide:server',
	},
	{
		kind: 'ses',
		hint: 'shared.useRelayCredentialDraft.providers.ses.hint',
		icon: 'lucide:cloud',
	},
	{
		kind: 'smtp',
		hint: 'shared.useRelayCredentialDraft.providers.smtp.hint',
		icon: 'lucide:route',
	},
	{
		kind: 'resend',
		hint: 'shared.useRelayCredentialDraft.providers.resend.hint',
		icon: 'lucide:zap',
	},
	{
		kind: 'mandrill',
		hint: 'shared.useRelayCredentialDraft.providers.mandrill.hint',
		icon: 'lucide:shuffle',
	},
	{
		kind: 'emailit',
		hint: 'shared.useRelayCredentialDraft.providers.emailit.hint',
		icon: 'lucide:send',
	},
];

/** The catalog's kinds, ordered by the copy table above and then by the catalog. */
function pickerOrderedKinds(): readonly string[] {
	const copyOrder = TRANSPORT_PICKER_COPY.map((row) => row.kind).filter((kind) =>
		COMPOSED_SEND_TRANSPORT_KINDS.includes(kind as never)
	);
	return [
		...copyOrder,
		...COMPOSED_SEND_TRANSPORT_KINDS.filter((kind) => !copyOrder.includes(kind)),
	];
}

function pickerOption(kind: string): RelayProviderOption {
	const copy = TRANSPORT_PICKER_COPY.find((row) => row.kind === kind);
	return {
		value: kind as RelayProviderChoice,
		label: copy?.label ?? composedSendProviderCatalogEntry(kind)?.label ?? kind,
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
	/** i18n message key (or the catalog's own label) — resolve with `t()`. */
	readonly label: string;
	/** i18n message key — resolve with `t()`; empty when the kind has no copy. */
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
export type ProbeRequestBuilder = (
	values: TransportCredentialValues,
	endpoint: SendProviderHostPortField | undefined
) => Record<string, unknown>;

const PROBE_REQUEST_BODIES: Record<string, ProbeRequestBuilder> = {
	validateResendKey: (values) => ({ apiKey: values['RESEND_API_KEY'] ?? '' }),
	validateEmailitKey: (values) => ({ apiKey: values['EMAILIT_API_KEY'] ?? '' }),
	validateSmtpRelay: (values, endpoint) => {
		const port = (values['SMTP_RELAY_PORT'] ?? '').trim();
		// The BLANK-PORT fallback is the descriptor's `portDefault`, not a literal
		// repeated here: the env patch already writes that same declared default,
		// so a probe with its own number would hand the operator a successful
		// handshake against a port the applied transport does not use.
		const declaredPort = (endpoint?.portDefault ?? '').trim();
		return {
			smtp: {
				host: (values['SMTP_RELAY_HOST'] ?? '').trim(),
				port: Number.parseInt(port || declaredPort || '587', 10),
				secure: values['SMTP_RELAY_SECURE'] === 'true',
				username: values['SMTP_RELAY_USERNAME'] ?? '',
				password: values['SMTP_RELAY_PASSWORD'] ?? '',
			},
		};
	},
};

/**
 * The builder a probe's live check sends its body with, or `undefined` when the
 * probe has none — the ONE reading of the table above.
 *
 * Exported so the endpoint's own suite (`server/api/delivery/__tests__/
 * validate-transport-probes.test.ts`) can post the body the SHIPPED editor
 * posts. That suite asks whether `/api/delivery/validate-transport` accepts what
 * each declared probe sends; with a fixture of its own it would only ever have
 * proved that the endpoint accepts what its author wrote, leaving a rename of a
 * key here green on both sides and 400 on every "Test connection" click.
 */
export function probeRequestBuilder(
	validator: string | undefined
): ProbeRequestBuilder | undefined {
	return validator === undefined ? undefined : PROBE_REQUEST_BODIES[validator];
}

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
	/**
	 * Missing required descriptor value, for every core or plugin transport — as
	 * the message key plus the field name it interpolates, because this composable
	 * is also created outside a component (its own suite does) and has no `t()`.
	 * The screen that announces it resolves both halves.
	 */
	readonly requiredCredentialError: ComputedRef<MissingCredentialMessage | undefined>;
	clearEnteredSecrets(): void;
	/** The shipped live handshake, or null when this kind has none. */
	validateLive(): Promise<ValidateTransportResponse | null>;
}

/** The blank form for every kind at once, so switching provider keeps input. */
function seedAllCredentialValues(): TransportCredentialValues {
	const values: TransportCredentialValues = {};
	for (const entry of COMPOSED_SEND_PROVIDER_CATALOG_ENTRIES) {
		Object.assign(values, seedCredentialValues(entry.kind));
	}
	return values;
}

/** The preset a `host-port` field starts on: the first the descriptor offers. */
function seedPreset(): SmtpPreset {
	for (const entry of COMPOSED_SEND_PROVIDER_CATALOG_ENTRIES) {
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
	const secretKeys = secretEnvKeys(
		COMPOSED_SEND_PROVIDER_CATALOG_ENTRIES.map((entry) => entry.kind)
	);

	const enteredSecrets = computed(() => secretKeys.map((key) => credentialValues[key] ?? ''));

	const activeProbe = computed(() => composedSendProviderCatalogEntry(provider.value)?.setupProbe);
	const missingRequiredCredential = computed(() =>
		requiredCredentialError(provider.value, credentialValues)
	);

	const canValidateLive = computed(
		() => probeRequestBuilder(activeProbe.value?.validator) !== undefined
	);

	function clearEnteredSecrets(): void {
		for (const key of secretKeys) credentialValues[key] = '';
	}

	async function validateLive(): Promise<ValidateTransportResponse | null> {
		const buildBody = probeRequestBuilder(activeProbe.value?.validator);
		if (buildBody === undefined) return null;
		return await $fetch<ValidateTransportResponse>('/api/delivery/validate-transport', {
			method: 'POST',
			body: {
				provider: provider.value,
				...buildBody({ ...credentialValues }, hostPortField.value),
			},
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
		requiredCredentialError: missingRequiredCredential,
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
	relayRemovalConfirmation?: string,
	credentialValues?: TransportCredentialValues
): Promise<ApplyTransportResponse> {
	// An empty base, so only the transport keys are sent; the backend allowlists
	// and clears the rest.
	const providerEnv = buildProviderEnv({}, draft, credentialValues);
	return await $fetch<ApplyTransportResponse>('/api/delivery/apply-transport', {
		method: 'POST',
		body: { providerEnv, relayRemovalConfirmation },
	});
}
