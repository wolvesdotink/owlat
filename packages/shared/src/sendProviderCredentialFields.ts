/**
 * Send-provider CREDENTIAL FIELDS — the typed UI field descriptors of the seams
 * plan's D5 ("a provider is a bundle; UI renders descriptors, it doesn't know
 * providers"), plus the SMTP relay preset table that is one field's data.
 *
 * DATA ONLY. A descriptor names a field, its label, and the DEPLOYMENT ENV
 * VARIABLE that carries its value — never the value itself. This module ends up
 * in the web client bundle, so there is nothing here a browser may not see (the
 * seams plan's D1 risk row: "moving catalog data to packages/shared leaks
 * backend concerns into client bundles").
 *
 * THE VOCABULARY, AND THE OPEN QUESTION P1.1 CLOSED. The plan asked whether
 * `credentialFields` should reuse the plugin platform's `settingsSchema` field
 * vocabulary exactly (`string | secret | number | boolean | select`,
 * `packages/plugin-kit/src/settingsSchema.ts`) or that base plus composite
 * kinds. The answer implemented here is the plan's recommendation: THE SAME FIVE
 * BASE KINDS, SPELLED IDENTICALLY, plus exactly two composites —
 * {@link SendProviderRegionSelectField} and {@link SendProviderHostPortField}.
 * "Spelled identically" is ENFORCED rather than asserted in prose — see
 * {@link SEND_PROVIDER_CREDENTIAL_FIELD_KINDS} for where the two vocabularies
 * are pinned to each other, and why the pin cannot live in this package.
 *
 * WHAT "SPELLED IDENTICALLY" COVERS, EXACTLY: the KIND NAMES, and nothing else.
 * The pin compares the two vocabularies' kind lists; it says nothing about the
 * per-kind property sets, and those DO differ today. A renderer author writing
 * the one component both tiers were meant to share must read this list first:
 *
 *  - `envVar` is on EVERY field here (a core credential's whole purpose is to
 *    name the deployment variable it writes) and on plugin-kit's `secret` field
 *    ALONE — a plugin `string`/`number`/`boolean`/`select` value is STORED by the
 *    host, not written to the environment, so binding `field.envVar` for one
 *    yields `undefined` and a control that writes nowhere.
 *  - `string` carries {@link SendProviderStringField.placeholder} here and
 *    `maxLength` in plugin-kit; neither has the other's. `secret` carries a
 *    `placeholder` here and nothing but `envVar` there.
 *  - plugin-kit additionally bounds a schema (`MAX_SETTINGS_FIELDS`,
 *    `MAX_TEXT_LENGTH`, `RESERVED_FIELD_KEYS`) because a plugin manifest is
 *    untrusted input validated at install time. These descriptors are in-repo
 *    literals, so they have no manifest validator and no such bounds.
 *
 * THE DIVERGENCE ABOVE IS THE SETTINGS FORM'S, AND IT STAYS. A plugin's
 * `settingsSchema` describes operator settings the host STORES; these describe
 * credentials the DEPLOYMENT carries. P3.1 (contract parity) did not reconcile
 * those two — it gave a bundled SEND TRANSPORT a `credentialFields` declaration
 * of its own, shaped to THIS module rather than to `settingsSchema`
 * (`PluginSendTransportCredentialField` in
 * `packages/plugin-kit/src/sendTransportCredentials.ts`): the base five kinds,
 * `envVar` on every one of them, and the composites withheld because a plugin can
 * express the same configuration as their parts. A generated entry's descriptors
 * therefore land in the same `credentialFields` a core entry's do, and the
 * assignment is pinned at build time by
 * `apps/api/convex/lib/sendProviders/__tests__/credentialFieldVocabulary.test.ts`.
 * Plugin codegen emits the composed data-only catalog into `apps/web`, where the
 * transport editor renders these descriptors and derives its env allowlist; the
 * backend receives the byte-identical rendered catalog.
 *
 * One validator family is the point. A renderer that already knows how to draw a
 * plugin's `secret` field draws a core provider's the same way, and the two
 * tiers converge rather than diverge when plugin transports gain capability
 * metadata (the seams plan's P3.1). The composites earn their place by carrying
 * a RELATIONSHIP the base kinds cannot express and a renderer would otherwise
 * have to hard-code per vendor: a region belongs to the provider's own closed
 * set of region identifiers, and a relay endpoint is host + port + implicit-TLS
 * moving together under one preset. Both are decomposable — each names its env
 * variables explicitly — so a renderer that does not implement a composite can
 * still fall back to its parts.
 *
 * The `secret` kind matches the plugin platform's meaning exactly: the value is
 * supplied through the deployment environment and is never rendered back. The
 * transport editor's write-only credential drafts
 * (`apps/web/app/composables/useRelayCredentialDraft.ts`) are already that rule.
 *
 * WHAT IS NOT HERE: hints, icons, per-vendor prose, and the operator-facing
 * option copy for values that belong to another module's contract (the
 * outbound-TLS option hints live beside the wizard). Descriptors carry the
 * label a form needs; the rest stays where the copy is written.
 */

import { deepFreeze } from './deepFreeze';
import type { OutboundTlsMode } from './outboundTlsMode';

/**
 * The outbound-TLS floor, as the transport form's option list — one
 * `select` field's OPTION DATA, which is why it lives beside the field kinds
 * rather than beside the entry that attaches it (the SMTP preset table moved
 * here for the same reason).
 *
 * `satisfies` against {@link OutboundTlsMode} rather than a free-text select, so
 * renaming a mode in `./outboundTlsMode` breaks this build instead of leaving
 * the form writing a value the backend rejects. That the list is COMPLETE is
 * pinned by the catalog suite, which compares it to `OUTBOUND_TLS_MODES`.
 *
 * EXPORTED because the wizard's selector derives from it. The label is a
 * descriptor's copy and has ONE home — `setupOutboundTls.ts` in `apps/web` maps
 * this list and adds only its own `hint` paragraph, so renaming a label here
 * renames it in the rendered form too. A second hand-written copy of the labels
 * would be exactly the duplication this catalog exists to collapse.
 */
export const OUTBOUND_TLS_MODE_OPTIONS = [
	{ value: 'opportunistic', label: 'Opportunistic (recommended)' },
	{ value: 'require', label: 'Always encrypt' },
	{ value: 'require-verified', label: 'Always encrypt and verify' },
] as const satisfies readonly { readonly value: OutboundTlsMode; readonly label: string }[];

/**
 * The field kinds a provider's credential form is described with — the plugin
 * `settingsSchema` vocabulary plus the two composites argued above.
 *
 * A VALUE, not just a type, because "spelled identically" has to be checkable.
 * `packages/shared` may not import `@owlat/plugin-kit` (nothing in this package
 * may depend on the plugin platform), so the two lists cannot be one
 * declaration; what keeps them from diverging silently is
 * `apps/api/convex/lib/sendProviders/__tests__/credentialFieldVocabulary.test.ts`,
 * a package that may import both, which pins `SETTINGS_FIELD_KINDS` as a subset
 * of this list at build time AND at run time. A kind added to (or renamed in)
 * plugin-kit is a red suite the moment it happens, instead of a renderer with no
 * branch for it discovered at P3.1.
 */
export const SEND_PROVIDER_CREDENTIAL_FIELD_KINDS = [
	// The plugin `settingsSchema` five, in its order.
	'string',
	'secret',
	'number',
	'boolean',
	'select',
	// The two composites.
	'region-select',
	'host-port',
] as const;

/** One of {@link SEND_PROVIDER_CREDENTIAL_FIELD_KINDS}. */
export type SendProviderCredentialFieldKind = (typeof SEND_PROVIDER_CREDENTIAL_FIELD_KINDS)[number];

interface SendProviderCredentialFieldCommon {
	/** Stable identifier within the provider's form. */
	readonly key: string;
	/** The form label, as the shipped surfaces already word it. */
	readonly label: string;
	/** One sentence of operator guidance; omitted when the label says it all. */
	readonly description?: string;
	/**
	 * Must this field be filled for the transport to be usable?
	 *
	 * It qualifies {@link SendProviderCredentialFieldCommon.envVar} AND NOTHING
	 * ELSE. Mirrors the entry's `requiredEnvVars`: `required: true` ⇒ `envVar` is
	 * in that list, `required` absent ⇒ it is not. A composite's SECONDARY
	 * variables (a {@link SendProviderHostPortField}'s `portEnvVar` and
	 * `secureEnvVar`) are always optional — they carry declared defaults — so they
	 * belong to `optionalEnvVars` however this flag reads. The rule a
	 * `credentialsConsistency` guard should encode is therefore about `envVar`
	 * alone, not about {@link credentialFieldEnvVars}, which answers with the
	 * whole composite.
	 */
	readonly required?: boolean;
	/** The deployment environment variable this field's value is written to. */
	readonly envVar: string;
}

/** A single-line free-text value (the plugin platform's `string`). */
export interface SendProviderStringField extends SendProviderCredentialFieldCommon {
	readonly kind: 'string';
	readonly default?: string;
	/** Shown in the empty input; an EXAMPLE, never a value that gets submitted. */
	readonly placeholder?: string;
}

/**
 * A sensitive credential. Write-only: the form collects it, the deployment env
 * holds it, and no surface ever renders it back — the same contract the plugin
 * platform's `secret` field states at length.
 */
export interface SendProviderSecretField extends SendProviderCredentialFieldCommon {
	readonly kind: 'secret';
	readonly placeholder?: string;
}

/** A numeric value (the plugin platform's `number`). */
export interface SendProviderNumberField extends SendProviderCredentialFieldCommon {
	readonly kind: 'number';
	readonly default?: number;
	readonly min?: number;
	readonly max?: number;
}

/** A toggle (the plugin platform's `boolean`). */
export interface SendProviderBooleanField extends SendProviderCredentialFieldCommon {
	readonly kind: 'boolean';
	readonly default?: boolean;
}

/** One option of a {@link SendProviderSelectField} / region select. */
export interface SendProviderFieldOption {
	readonly value: string;
	readonly label: string;
}

/** A choice from a closed, declared set (the plugin platform's `select`). */
export interface SendProviderSelectField extends SendProviderCredentialFieldCommon {
	readonly kind: 'select';
	readonly options: readonly SendProviderFieldOption[];
	readonly default?: string;
}

/**
 * COMPOSITE 1 — the provider's REGION identifier.
 *
 * Structurally a select whose option set is the provider's, not ours: SES's
 * region list changes when AWS adds a region, and pinning it here would be a
 * table that goes stale silently and blocks an operator from a region that
 * exists. So `options` is optional — declare it only when the set is genuinely
 * closed — and the renderer falls back to a text input seeded from `default`,
 * which is exactly what the shipped SES form does today.
 *
 * It is not just a `string` field because the RELATIONSHIP is the point: a
 * renderer (or a future region picker) can act on "this is the provider's
 * region" without knowing which provider asked.
 */
export interface SendProviderRegionSelectField extends SendProviderCredentialFieldCommon {
	readonly kind: 'region-select';
	/** Present only when the provider's region set is closed and known to us. */
	readonly options?: readonly SendProviderFieldOption[];
	readonly default?: string;
	readonly placeholder?: string;
}

/**
 * COMPOSITE 2 — a relay ENDPOINT: host, port and implicit-TLS, which move
 * together.
 *
 * Three env variables under one descriptor because they are one decision. A
 * preset sets all three at once ({@link SmtpRelayPresetConfig}), and the safe
 * defaults are a pair: STARTTLS on 587. Split into three base fields, a renderer
 * would have to re-learn per vendor that choosing "Postmark" fills the other
 * two, and that a blank port means 587 rather than "unset".
 *
 * Every part names its own env variable, so a renderer that ignores the
 * composite can still draw three plain fields and write the same env.
 *
 * `required` on this field qualifies the HOST (`envVar`) only. `portEnvVar` and
 * `secureEnvVar` are always OPTIONAL — each has a declared default below, which
 * is what makes a blank port mean 587 rather than "unset" — so they belong to
 * the entry's `optionalEnvVars` even on a field declared `required: true`.
 */
export interface SendProviderHostPortField extends SendProviderCredentialFieldCommon {
	readonly kind: 'host-port';
	/**
	 * `envVar` carries the host; these two carry the rest of the endpoint, and
	 * both are optional-with-a-default regardless of the field's `required`.
	 */
	readonly portEnvVar: string;
	readonly secureEnvVar: string;
	/** String because it feeds a form field; blank ⇒ the backend default 587. */
	readonly portDefault: string;
	/** true ⇒ implicit TLS (usually 465); false ⇒ STARTTLS upgrade (587). */
	readonly secureDefault: boolean;
	/**
	 * Shown in the empty HOST input — an EXAMPLE endpoint, never a value that
	 * gets submitted.
	 *
	 * The composite carries it because its parts hint as a SET: the port input
	 * already shows {@link SendProviderHostPortField.portDefault}, so a host with
	 * no example left the two halves of one decision inconsistent about whether
	 * they hint at all (which is exactly what happened when the shipped SMTP
	 * form's `placeholder="smtp.mailgun.org"` had nowhere to be declared).
	 */
	readonly placeholder?: string;
	/**
	 * Well-known endpoints this field prefills from — the field's own data, which
	 * is why the preset table moved here from `setupSendingPresets.ts` when the
	 * catalog became the single declaration (the seams plan's P1.1: "SMTP presets
	 * become catalog-attached data").
	 */
	readonly presets?: Readonly<Record<string, SmtpRelayPresetConfig>>;
}

/** One provider credential-form field. */
export type SendProviderCredentialField =
	| SendProviderStringField
	| SendProviderSecretField
	| SendProviderNumberField
	| SendProviderBooleanField
	| SendProviderSelectField
	| SendProviderRegionSelectField
	| SendProviderHostPortField;

/**
 * Which well-known relay a "SMTP relay" install points at; `custom` leaves the
 * fields for the operator.
 */
export type SmtpRelayPreset = 'mailgun' | 'postmark' | 'sendgrid' | 'brevo' | 'custom';

export interface SmtpRelayPresetConfig {
	label: string;
	/** Blank for `custom` ⇒ the operator fills it in. */
	host: string;
	/** String because it feeds a form field. */
	port: string;
	secure: boolean;
}

/**
 * Connection presets for the generic SMTP relay transport — the single source
 * of truth both the web setup wizard (`apps/web/app/pages/setup/email.vue`) and
 * the setup CLI (`apps/setup-cli`) prefill from, so the two can never drift.
 *
 * There is deliberately no per-provider API adapter: every one of these speaks
 * plain SMTP submission, so a single set of `SMTP_RELAY_*` env vars drives them
 * all. Ports/TLS mirror each provider's documented submission endpoint; every
 * one defaults to STARTTLS on 587, which the backend `smtp` adapter upgrades and
 * enforces (`requireTLS`). `custom` carries the same safe default so the fields
 * are never empty.
 *
 * Attached to the `smtp` entry's {@link SendProviderHostPortField} in
 * `./sendProviderCatalog`, and re-exported from `./setupSendingPresets` where
 * the two callers above still import it from.
 *
 * FROZEN THROUGH, table and rows — by {@link deepFreeze}, the same call the
 * catalog itself is frozen with, rather than by a hand-rolled `Object.freeze`
 * per row (which is a step the sixth preset gets written without). The type says
 * `SmtpRelayPresetConfig` with mutable members because two shipped callers
 * spread a row into a form draft and a readonly type would ripple through both;
 * the runtime freeze is what actually holds. Reachable as
 * `smtp.credentialFields[0].presets` from a module described as the single
 * source of truth, it is exactly the object an untyped or cast consumer could
 * rewrite for every later reader.
 */
export const SMTP_RELAY_PRESETS: Record<SmtpRelayPreset, SmtpRelayPresetConfig> = deepFreeze({
	mailgun: {
		label: 'Mailgun',
		host: 'smtp.mailgun.org',
		port: '587',
		secure: false,
	},
	postmark: {
		label: 'Postmark',
		host: 'smtp.postmarkapp.com',
		port: '587',
		secure: false,
	},
	sendgrid: {
		label: 'SendGrid',
		host: 'smtp.sendgrid.net',
		port: '587',
		secure: false,
	},
	brevo: {
		label: 'Brevo',
		host: 'smtp-relay.brevo.com',
		port: '587',
		secure: false,
	},
	custom: {
		label: 'Custom SMTP server',
		host: '',
		port: '587',
		secure: false,
	},
});

/**
 * Every deployment env variable one field owns, in declaration order.
 *
 * ONE definition, because two consumers must agree or a credential leaks past a
 * gate: `PROVIDER_ENV_KEYS` (the allowlist `POST /api/delivery/apply-transport`
 * checks a browser's patch against, and the clear-then-set list a transport swap
 * iterates) is derived from it, and any renderer that writes a field's value
 * reads the same names. A composite that answered only with `envVar` would leave
 * `SMTP_RELAY_PORT` outside the allowlist — unsettable by the editor that
 * renders it.
 */
export function credentialFieldEnvVars<F extends SendProviderCredentialField>(
	field: F
): readonly CredentialFieldEnvVar<F>[] {
	const names =
		field.kind === 'host-port'
			? [field.envVar, field.portEnvVar, field.secureEnvVar]
			: [field.envVar];
	// The conditional return type is the DECLARATION (it is what makes
	// `ProviderEnvKey` a union of literals rather than `string`); the body cannot
	// prove a conditional type to the checker, so the cast is where the two meet.
	// Both arms are enumerated directly above it.
	return names as CredentialFieldEnvVar<F>[];
}

/**
 * The env variables one field descriptor owns, at the type level — the
 * derivation {@link credentialFieldEnvVars} performs at runtime.
 *
 * Distributes over a union of field types, which is what lets `ProviderEnvKey`
 * stay a union of string LITERALS after the allowlist stopped being one: the
 * apply endpoint narrows on it, and a widened `string` would make its "only
 * transport keys may be patched" guard a runtime-only claim.
 */
export type CredentialFieldEnvVar<F extends SendProviderCredentialField> = F extends {
	readonly kind: 'host-port';
}
	? F['envVar'] | F['portEnvVar'] | F['secureEnvVar']
	: F['envVar'];
