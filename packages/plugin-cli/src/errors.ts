import { PluginCodegenError } from '@owlat/plugin-codegen';
import type { CliIo } from './io';

/**
 * Every failure the `owlat plugins` CLI reports to an operator is a
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
 * Render a failed CLI operation to the operator: the error's headline followed
 * by its indented detail lines. A `PluginCodegenError` raised deeper in
 * `@owlat/plugin-codegen` is unwrapped to the same message+details shape;
 * anything else prints only `fallback`, so an unexpected internal error never
 * leaks its `cause`, stack, or paths to the terminal. Both the entry point and
 * the `dev` loop report through this one function so the failure surface renders
 * identically regardless of where the failure originated.
 */
export function reportCliFailure(io: CliIo, error: unknown, fallback: string): void {
	const cliError =
		error instanceof PluginCodegenError
			? new PluginCliError(error.message, error.details, { cause: error })
			: error;
	if (cliError instanceof PluginCliError) {
		io.error(cliError.message);
		for (const detail of cliError.details) io.error(`  ${detail}`);
		return;
	}
	io.error(fallback);
}
