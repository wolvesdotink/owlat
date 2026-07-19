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
