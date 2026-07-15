export type PluginCodegenErrorCode =
	| 'composition_invalid'
	| 'conditional_manifest_export'
	| 'config_invalid'
	| 'dependency_missing'
	| 'dependency_provenance'
	| 'direct_plugin_import'
	| 'generated_files_stale'
	| 'generated_path_unsafe'
	| 'invalid_manifest'
	| 'package_load_failed'
	| 'repository_config_invalid'
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
