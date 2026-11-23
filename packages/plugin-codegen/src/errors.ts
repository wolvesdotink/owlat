export type PluginCodegenErrorCode =
	| 'composition_invalid'
	| 'component_export_invalid'
	| 'contribution_export_invalid'
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
	| 'repository_inventory_invalid'
	| 'source_invalid'
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

/**
 * One line per code saying what to do next. A `Record` over the code union, so
 * a new code does not compile until it says how to fix it.
 */
export const PLUGIN_CODEGEN_ERROR_HINTS: Readonly<Record<PluginCodegenErrorCode, string>> =
	Object.freeze({
		composition_invalid:
			'Two bundled plugins share a package name or manifest id, or their contributions conflict: remove or rename one.',
		component_export_invalid:
			"List the component's exportPath in the package's exports as one string that points at an existing file.",
		contribution_export_invalid:
			"List every contribution's module.exportPath in the package's exports as one string that points at an existing file.",
		conditional_manifest_export:
			'Make exports["."] in the package\'s package.json one string, for example "./src/index.ts".',
		config_invalid:
			'Keep plugins.config.ts a literal list of package names: it is read as data and never run.',
		dependency_missing:
			'Install the published package at the workspace root with `bun add --exact <package>@<version>`, then run this again.',
		dependency_provenance:
			'Install the plugin from a package registry: a workspace, file, git or URL source is refused. A plugin you are writing has to be published first (Building a Plugin, step 6).',
		direct_plugin_import: 'Import a bundled plugin only through the generated composition files.',
		generated_files_stale:
			'Run `bun run plugins:codegen` and commit the generated files together with plugins.config.ts.',
		generated_path_unsafe: 'Replace the symlinked generated file or directory with a real one.',
		invalid_manifest:
			"Fix each field listed above in the package's definePlugin manifest, and keep the manifest the root module's default export.",
		package_load_failed:
			"Fix the error above in the package's root module. Importing it must not need the network, environment variables or other setup.",
		repository_config_invalid:
			'Make the tsconfig and bundler alias files the scan reads plain, readable files of a bounded size.',
		repository_inventory_invalid:
			'The checkout has more files than the import-boundary scan allows: remove build output and other untracked trees.',
		source_invalid: 'Fix the syntax error in the named file.',
		workspace_not_found: 'Run the command from inside an Owlat checkout.',
	});

const MAX_UNEXPECTED_MESSAGE_LENGTH = 300;

/**
 * The lines a CLI prints for a failed codegen run.
 *
 * A `PluginCodegenError` prints its code, message, details and the code's hint.
 * Anything else is a bug in the tooling, not in the plugin, so it prints the
 * error's first message line and the frame that threw: enough to report or find
 * it, while the rest of the stack and any multi-line message (which can quote
 * file contents or values from the build host) stays out.
 */
export function formatPluginCodegenFailure(error: unknown): readonly string[] {
	if (error instanceof PluginCodegenError) {
		return [
			`${error.message} [${error.code}]`,
			...error.details.map((detail) => `  ${detail}`),
			`Next: ${PLUGIN_CODEGEN_ERROR_HINTS[error.code]}`,
		];
	}
	if (!(error instanceof Error)) return ['Failed unexpectedly: a non-Error value was thrown.'];
	const firstLine = error.message.split('\n', 1)[0]?.trim() ?? '';
	const message =
		firstLine.length > MAX_UNEXPECTED_MESSAGE_LENGTH
			? `${firstLine.slice(0, MAX_UNEXPECTED_MESSAGE_LENGTH)}…`
			: firstLine;
	const frame = error.stack
		?.split('\n')
		.map((line) => line.trim())
		.find((line) => line.startsWith('at '));
	return [
		`Failed unexpectedly: ${error.name}${message.length > 0 ? `: ${message}` : ''}`,
		...(frame ? [`  ${frame}`] : []),
		'This is a bug in the plugin tooling. Report it with the lines above.',
	];
}
