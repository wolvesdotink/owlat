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

export type PluginImportProviderCapability = typeof PLUGIN_IMPORT_PROVIDER_CAPABILITY;

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
	 * Its `replay` provisions are deliberately NOT accepted here: no HTTP surface
	 * dispatches import-provider callbacks yet, so declaring replay defense would
	 * describe a check nothing performs. The piece that opens that surface adds
	 * `replay: 'required'` to this validator, exactly as the send-transport
	 * feedback webhook does today.
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
