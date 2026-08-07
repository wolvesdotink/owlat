/**
 * The CREDENTIAL FORM a bundled send transport declares (the seams plan's D5,
 * given to the plugin tier by P3.1) — typed descriptors, no renderer.
 *
 * Split out of `./sendTransport` because it is a vocabulary rather than a
 * contract: nothing here decides what a send does. The transport definition
 * attaches it (`credentialFields`), the manifest validator joins every
 * descriptor's `envVar` to the transport's declared configuration, and the host
 * carries it into the composed catalog for whichever surface renders provider
 * credentials.
 *
 * Manifest-time validation lives in `./sendTransportManifest`, beside the rest
 * of the bucket's rules.
 */

import { PLUGIN_SEND_TRANSPORT_MAX_ENV_VARS } from './sendTransport';

/**
 * The most credential fields one transport may declare.
 *
 * The same bound as the configuration variables, because every field names
 * exactly one of them — a form can be smaller than the configuration (a variable
 * an operator never sets by hand), never larger.
 */
export const PLUGIN_SEND_TRANSPORT_MAX_CREDENTIAL_FIELDS = PLUGIN_SEND_TRANSPORT_MAX_ENV_VARS;

/**
 * The field kinds a bundled transport's credential form may use — the plugin
 * platform's `settingsSchema` five, unchanged.
 *
 * The catalog's own vocabulary
 * (`SEND_PROVIDER_CREDENTIAL_FIELD_KINDS` in `@owlat/shared`) is these five plus
 * two composites, `region-select` and `host-port`. The composites are NOT
 * offered here: each carries a relationship between several variables (a
 * provider's closed region set; host + port + implicit-TLS moving together under
 * a preset table) that only means something to a renderer that already knows the
 * relationship, and a plugin can express the same configuration as its parts —
 * which is exactly the fallback the shared descriptors document for a renderer
 * that does not implement a composite.
 */
export const PLUGIN_SEND_TRANSPORT_CREDENTIAL_FIELD_KINDS = [
	'string',
	'secret',
	'number',
	'boolean',
	'select',
] as const;

/** One of {@link PLUGIN_SEND_TRANSPORT_CREDENTIAL_FIELD_KINDS}. */
export type PluginSendTransportCredentialFieldKind =
	(typeof PLUGIN_SEND_TRANSPORT_CREDENTIAL_FIELD_KINDS)[number];

interface PluginSendTransportCredentialFieldCommon {
	/** Stable identifier within this transport's form. */
	readonly key: string;
	/** The form label. */
	readonly label: string;
	/** One sentence of operator guidance; omit when the label says it all. */
	readonly description?: string;
	/**
	 * Must this field be filled for the transport to be usable? It qualifies
	 * {@link PluginSendTransportCredentialFieldCommon.envVar} and nothing else,
	 * and it must agree with which declared list that variable is in.
	 */
	readonly required?: boolean;
	/** The declared variable this field's value is written to. */
	readonly envVar: string;
}

/** A single-line free-text value. */
export interface PluginSendTransportStringCredentialField extends PluginSendTransportCredentialFieldCommon {
	readonly kind: 'string';
	readonly default?: string;
	/** Shown in the empty input; an EXAMPLE, never a value that gets submitted. */
	readonly placeholder?: string;
}

/**
 * A sensitive credential. Write-only, exactly as the platform's settings
 * `secret` is: the deployment environment holds the value and no surface renders
 * it back.
 */
export interface PluginSendTransportSecretCredentialField extends PluginSendTransportCredentialFieldCommon {
	readonly kind: 'secret';
	readonly placeholder?: string;
}

/** A numeric value. */
export interface PluginSendTransportNumberCredentialField extends PluginSendTransportCredentialFieldCommon {
	readonly kind: 'number';
	readonly default?: number;
	readonly min?: number;
	readonly max?: number;
}

/** A toggle. */
export interface PluginSendTransportBooleanCredentialField extends PluginSendTransportCredentialFieldCommon {
	readonly kind: 'boolean';
	readonly default?: boolean;
}

/** One option of a {@link PluginSendTransportSelectCredentialField}. */
export interface PluginSendTransportCredentialFieldOption {
	readonly value: string;
	readonly label: string;
}

/** A choice from a closed, declared set. */
export interface PluginSendTransportSelectCredentialField extends PluginSendTransportCredentialFieldCommon {
	readonly kind: 'select';
	readonly options: readonly PluginSendTransportCredentialFieldOption[];
	readonly default?: string;
}

/**
 * One credential-form field.
 *
 * STRUCTURALLY A `SendProviderCredentialField` (`@owlat/shared`), narrowed to
 * the five base kinds: a generated plugin entry's descriptors land in the same
 * catalog field a core entry's do, so a renderer reading the composed catalog
 * cannot tell which tier wrote them. `packages/shared` may not depend on this
 * package, so the two declarations cannot be one — what holds them together is
 * `apps/api/convex/lib/sendProviders/__tests__/credentialFieldVocabulary.test.ts`,
 * a package that may import both and asserts the assignment at build time.
 */
export type PluginSendTransportCredentialField =
	| PluginSendTransportStringCredentialField
	| PluginSendTransportSecretCredentialField
	| PluginSendTransportNumberCredentialField
	| PluginSendTransportBooleanCredentialField
	| PluginSendTransportSelectCredentialField;
