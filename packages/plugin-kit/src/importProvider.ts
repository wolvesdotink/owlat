import type { PluginLocalId, PluginNamespacedKind } from './namespacedKind';
import type { JsonObject } from './json';
import type { PluginInboundSignatureContract } from './inboundSignature';
import type { PluginStaticModuleExport } from './sendTransport';

export type {
	PluginInboundReplayContract,
	PluginInboundSignatureAlgorithm,
	PluginInboundSignatureContract,
	PluginInboundSignatureEncoding,
} from './inboundSignature';

/** Capability the host assigns to every plugin that contributes import providers. */
export const PLUGIN_IMPORT_PROVIDER_CAPABILITY = 'imports:provide' as const;

/** Collision-safe provider kind; the walker resolves it through the host. */
export type PluginImportProviderKind = PluginNamespacedKind;

/**
 * Data-only descriptor for one import provider a plugin contributes. Executable
 * code lives at `module.exportPath`; the host loads it behind a Node runtime
 * boundary and drives it through the provider-agnostic import walker.
 */
export interface PluginImportProviderDefinition {
	readonly id: PluginLocalId;
	readonly label: string;
	readonly module: PluginStaticModuleExport;
	/**
	 * Required inbound signature-verification contract for plugin-sourced events.
	 *
	 * Passing it proves ORIGIN ONLY — that the request was signed with the shared
	 * secret. It carries no replay resistance: the signed payload is the raw body
	 * alone, with no timestamp, tolerance, or nonce, so a captured request
	 * verifies forever. That is tolerable here and only here, because no HTTP
	 * surface dispatches import-provider callbacks yet. The contract's `replay`
	 * provisions are therefore deliberately NOT accepted on this bucket —
	 * declaring a defense nothing performs is worse than declaring none — and the
	 * piece that opens that surface flips this validator to `replay: 'required'`,
	 * exactly as the send-transport feedback webhook already is.
	 */
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
