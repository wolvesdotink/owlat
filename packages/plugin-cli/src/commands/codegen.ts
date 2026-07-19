import { generatePluginComposition, PluginCodegenError } from '@owlat/plugin-codegen';
import { PluginCliError } from '../errors';
import type { CliIo } from '../io';

export interface CodegenOptions {
	readonly check?: boolean;
	readonly boundariesOnly?: boolean;
}

/**
 * Regenerate (or check) the bundled plugin composition by delegating to the
 * PP-03 codegen. The CLI does not re-implement composition; it reuses the one
 * deterministic, provenance-gated generator so `owlat plugins codegen` and the
 * `plugins:codegen` build script always produce identical output.
 */
export async function runCodegen(
	workspaceRoot: string,
	options: CodegenOptions,
	io: CliIo
): Promise<void> {
	if (options.check && options.boundariesOnly) {
		throw new PluginCliError('--check and --boundaries-only cannot be used together');
	}
	try {
		await generatePluginComposition(workspaceRoot, {
			check: options.check,
			boundariesOnly: options.boundariesOnly,
		});
	} catch (cause) {
		if (cause instanceof PluginCodegenError) {
			throw new PluginCliError(cause.message, cause.details, { cause });
		}
		throw cause;
	}
	io.log(
		options.boundariesOnly
			? 'Plugin package boundaries are valid.'
			: options.check
				? 'Bundled plugin composition is current.'
				: 'Generated bundled plugin composition.'
	);
}
