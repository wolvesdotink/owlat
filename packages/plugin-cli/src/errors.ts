import {
	formatPluginCodegenFailure,
	PLUGIN_CODEGEN_ERROR_HINTS,
	PluginCodegenError,
} from '@owlat/plugin-codegen';
import type { CliIo } from './io';

/**
 * Every failure the `owlat-plugins` CLI reports to an operator is a
 * `PluginCliError`: a single human-readable headline plus optional indented
 * detail lines (for example the rollback guidance printed when a config edit
 * cannot be completed). Codegen and manifest-provenance failures raised deeper
 * in `@owlat/plugin-codegen` are caught at the command boundary and re-wrapped
 * as a `PluginCliError` so the surface presents one consistent, actionable
 * shape regardless of where the failure originated.
 */
export class PluginCliError extends Error {
	readonly details: readonly string[];

	constructor(message: string, details: readonly string[] = [], options?: ErrorOptions) {
		super(message, options);
		this.name = 'PluginCliError';
		this.details = Object.freeze([...details]);
	}
}

/**
 * Render a failed CLI operation: the error's headline followed by its indented
 * detail lines. When the failure started as a `PluginCodegenError`, the headline
 * carries its code and a last line says what to do next, the same lines the
 * codegen script prints. Anything else is a tooling bug and prints its first
 * message line and the frame that threw (see `formatPluginCodegenFailure`).
 * Both the entry point and the `dev` loop report through this one function so
 * the failure surface renders identically regardless of where it originated.
 */
export function reportCliFailure(io: CliIo, error: unknown): void {
	if (error instanceof PluginCliError) {
		const codegen = error.cause instanceof PluginCodegenError ? error.cause : undefined;
		io.error(codegen ? `${error.message} [${codegen.code}]` : error.message);
		for (const detail of error.details) io.error(`  ${detail}`);
		if (codegen) io.error(`Next: ${PLUGIN_CODEGEN_ERROR_HINTS[codegen.code]}`);
		return;
	}
	for (const line of formatPluginCodegenFailure(error)) io.error(line);
}
