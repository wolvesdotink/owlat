export type PluginCodegenErrorCode =
	| 'composition_invalid'
	| 'config_invalid'
	| 'dependency_missing'
	| 'direct_plugin_import'
	| 'generated_files_stale'
	| 'invalid_manifest'
	| 'package_load_failed'
	| 'workspace_not_found';

export class PluginCodegenError extends Error {
	readonly code: PluginCodegenErrorCode;
	readonly details: readonly string[];

	constructor(
		code: PluginCodegenErrorCode,
		message: string,
		details: readonly string[] = [],
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = 'PluginCodegenError';
		this.code = code;
		this.details = Object.freeze([...details]);
	}
}
