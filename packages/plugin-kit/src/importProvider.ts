import type { PluginLocalId, PluginNamespacedKind } from './namespacedKind';
import type { JsonObject } from './json';
import type { PluginStaticModuleExport } from './sendTransport';

/** Capability the host assigns to every plugin that contributes import providers. */
export const PLUGIN_IMPORT_PROVIDER_CAPABILITY = 'imports:provide' as const;

export type PluginImportProviderCapability = typeof PLUGIN_IMPORT_PROVIDER_CAPABILITY;

/** Collision-safe provider kind; the walker resolves it through the host. */
export type PluginImportProviderKind = PluginNamespacedKind;

/** HMAC families the host can recompute and compare in constant time. */
export type PluginInboundSignatureAlgorithm = 'hmac-sha256' | 'hmac-sha1';
export type PluginInboundSignatureEncoding = 'hex' | 'base64';

/**
 * Required contract describing how the host verifies the signature on any
 * inbound request a plugin import provider receives — provider webhook
 * callbacks, paged-fetch continuation callbacks, or event notifications.
 *
 * The host reads the shared secret from `secretEnvVar`, recomputes the
 * `algorithm` HMAC over the raw request body, encodes it as `encoding`, and
 * compares it against the value carried in the `header` using a constant-time
 * comparison. Verification fails closed when the secret is unset or the header
 * is missing, malformed, or does not match — a plugin can never opt out of it.
 *
 * Scope of the guarantee: passing this check proves **origin only** — that the
 * request was signed with the shared secret. It carries no replay resistance:
 * the signed payload is the raw body alone, with no timestamp, tolerance, or
 * nonce, so a captured request verifies forever. This contract does not gate
 * any HTTP endpoint today (none exists yet). The future piece that wires the
 * inbound HTTP surface MUST layer replay defense (a signed timestamp with a
 * bounded tolerance, and/or a nonce) on top of this check before any endpoint
 * accepts plugin-sourced traffic. Replay provisions can be added here later as
 * OPTIONAL fields without breaking existing manifests.
 */
export interface PluginInboundSignatureContract {
	/** Lower-cased HTTP header carrying the caller-supplied signature. */
	readonly header: string;
	readonly algorithm: PluginInboundSignatureAlgorithm;
	readonly encoding: PluginInboundSignatureEncoding;
	/** Environment variable holding the shared signing secret. */
	readonly secretEnvVar: string;
}

/**
 * Data-only descriptor for one import provider a plugin contributes. Executable
 * code lives at `module.exportPath`; the host loads it behind a Node runtime
 * boundary and drives it through the provider-agnostic import walker.
 */
export interface PluginImportProviderDefinition {
	readonly id: PluginLocalId;
	readonly label: string;
	readonly module: PluginStaticModuleExport;
	/** Required inbound signature-verification contract for plugin-sourced events. */
	readonly signature: PluginInboundSignatureContract;
	/** Optional per-provider default double-opt-in attestation source label. */
	readonly attestSource?: string;
}

/** Bounded, host-normalized contact row a plugin provider yields per page. */
export interface PluginImportRow {
	readonly email: string;
	readonly fields?: JsonObject;
}

export interface PluginImportPageResult {
	readonly rows: readonly PluginImportRow[];
	/** `null` = terminal page. Any other opaque string schedules the next hop. */
	readonly nextCursor: string | null;
	readonly totalEstimate?: number;
}

export interface PluginImportProviderInput {
	/** Provider config, already redacted of host-only fields. */
	readonly config: JsonObject;
	/** Opaque cursor; `''` on the first page. */
	readonly cursor: string;
}

/** Trusted bundled module invoked only after the host reauthorizes the plugin. */
export interface PluginImportProviderModule {
	validateConfig(
		config: JsonObject
	): { readonly ok: true } | { readonly ok: false; readonly reason: string };
	fetchPage(input: PluginImportProviderInput): Promise<PluginImportPageResult>;
}
