import type { PluginId } from './pluginId';

/** Capability assigned by the host to every bundled send transport. */
export const PLUGIN_SEND_TRANSPORT_CAPABILITY = 'send:transport' as const;

export type PluginSendTransportCapability = typeof PLUGIN_SEND_TRANSPORT_CAPABILITY;

/** Local contribution identity. The host namespaces it with the owning plugin id. */
export type PluginSendTransportLocalId = string;

/** Collision-safe transport kind stored in routes and health records. */
export type PluginSendTransportKind = `plugin.${PluginId}.${PluginSendTransportLocalId}`;

/** A condition-independent package export verified and imported by codegen. */
export interface PluginStaticModuleExport {
	readonly exportPath: string;
}

/** Data-only manifest descriptor. Executable code lives at `module.exportPath`. */
export interface PluginSendTransportDefinition {
	readonly id: PluginSendTransportLocalId;
	readonly label: string;
	readonly module: PluginStaticModuleExport;
	/** Host-owned delays after retryable failures; at most three bounded entries. */
	readonly retryDelays: readonly number[];
}

export interface PluginSendAttachment {
	readonly filename: string;
	readonly content: Uint8Array;
	readonly contentType?: string;
}

/** Host-normalized message passed to one trusted bundled transport attempt. */
export interface PluginSendTransportParams {
	readonly to: string;
	readonly from: string;
	readonly subject: string;
	readonly html: string;
	readonly text?: string;
	readonly replyTo?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly attachments?: readonly PluginSendAttachment[];
}

/** Typed terminal/retry semantics. Plugins never control host error text. */
export const PLUGIN_SEND_FAILURE_CODES = [
	'rate_limited',
	'temporary_failure',
	'ambiguous_timeout',
	'invalid_recipient',
	'invalid_sender',
	'authentication_failed',
	'content_rejected',
	'unknown',
] as const;

export type PluginSendFailureCode = (typeof PLUGIN_SEND_FAILURE_CODES)[number];

export type PluginSendAttempt =
	| { readonly success: true; readonly id: string }
	| { readonly success: false; readonly code: PluginSendFailureCode };

/**
 * Executable Node module exported by a bundled plugin.
 *
 * `parseExtras` is the sole unknown-input boundary and must either return the
 * transport's honest extras type or throw. `send` performs exactly one network
 * attempt; Owlat owns authorization, retries, health, and audit.
 */
export interface PluginSendTransportModule<Extras = unknown> {
	parseExtras(input: unknown): Extras;
	send(params: PluginSendTransportParams, extras: Extras): Promise<PluginSendAttempt>;
}

export function pluginSendTransportKind(
	pluginId: PluginId,
	localId: PluginSendTransportLocalId
): PluginSendTransportKind {
	return `plugin.${pluginId}.${localId}`;
}
