import type { PluginCapability, PluginId } from '@owlat/plugin-kit';

export type PluginHostErrorCode =
	| 'capability_not_declared'
	| 'capability_not_granted'
	| 'environment_check_failed'
	| 'feature_check_failed'
	| 'invalid_capability_grant'
	| 'invalid_contribution'
	| 'invalid_manifest_snapshot'
	| 'invalid_untrusted_text_policy'
	| 'plugin_disabled'
	| 'required_environment_missing'
	| 'untrusted_output_rejected';

export interface PluginHostErrorDetails {
	readonly pluginId?: PluginId;
	readonly capability?: PluginCapability;
	readonly environmentVariable?: string;
	readonly cause?: unknown;
}

/** A policy denial or invalid host configuration at the plugin boundary. */
export class PluginHostError extends Error {
	readonly code: PluginHostErrorCode;
	readonly pluginId?: PluginId;
	readonly capability?: PluginCapability;
	readonly environmentVariable?: string;

	constructor(code: PluginHostErrorCode, message: string, details: PluginHostErrorDetails) {
		super(message);
		this.name = 'PluginHostError';
		this.code = code;
		this.pluginId = details.pluginId;
		this.capability = details.capability;
		this.environmentVariable = details.environmentVariable;
		if (details.cause !== undefined) {
			Object.defineProperty(this, 'cause', {
				configurable: true,
				value: details.cause,
			});
		}
	}
}
