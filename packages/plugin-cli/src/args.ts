import { PluginCliError } from './errors';

export interface ArgSpec {
	/** Boolean switches, e.g. `--dry-run`. */
	readonly booleans?: readonly string[];
	/** Options that take a value, e.g. `--dir <path>`. */
	readonly values?: readonly string[];
}

export interface ParsedArgs {
	readonly positionals: readonly string[];
	readonly booleans: ReadonlySet<string>;
	readonly values: ReadonlyMap<string, string>;
}

/**
 * A small, strict flag parser shared by every subcommand. It accepts
 * `--flag`, `--opt value`, and `--opt=value`, rejects unknown flags and missing
 * values up front, and treats everything else as a positional — so malformed
 * invocations fail with an actionable message before any side effect runs.
 */
export function parseArgs(argv: readonly string[], spec: ArgSpec): ParsedArgs {
	const booleanFlags = new Set(spec.booleans ?? []);
	const valueFlags = new Set(spec.values ?? []);
	const positionals: string[] = [];
	const booleans = new Set<string>();
	const values = new Map<string, string>();

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === undefined || !argument.startsWith('--')) {
			if (argument !== undefined) positionals.push(argument);
			continue;
		}
		const equalsIndex = argument.indexOf('=');
		const name = equalsIndex === -1 ? argument.slice(2) : argument.slice(2, equalsIndex);
		const inlineValue = equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1);

		if (booleanFlags.has(name)) {
			if (inlineValue !== undefined) {
				throw new PluginCliError(`--${name} does not take a value`);
			}
			booleans.add(name);
			continue;
		}
		if (valueFlags.has(name)) {
			if (inlineValue !== undefined) {
				values.set(name, inlineValue);
				continue;
			}
			// Take the value from the following token, but refuse a flag-shaped
			// token: `--dir --dry-run` must fail loudly rather than silently
			// swallow `--dry-run` as the `--dir` value. The `--opt=value` inline
			// form above stays the escape hatch for a value that starts with `--`.
			const next = argv[index + 1];
			if (next === undefined || next.startsWith('--')) {
				throw new PluginCliError(`--${name} requires a value`);
			}
			index += 1;
			values.set(name, next);
			continue;
		}
		throw new PluginCliError(`Unknown option: --${name}`);
	}

	return { positionals, booleans, values };
}

/** Require exactly one positional argument (for example the package name or plugin id). */
export function requireSinglePositional(args: ParsedArgs, label: string): string {
	if (args.positionals.length === 0) throw new PluginCliError(`Missing required ${label}`);
	if (args.positionals.length > 1) {
		throw new PluginCliError(
			`Expected exactly one ${label} but got: ${args.positionals.join(', ')}`
		);
	}
	return args.positionals[0] as string;
}

export function requireNoPositionals(args: ParsedArgs, command: string): void {
	if (args.positionals.length > 0) {
		throw new PluginCliError(
			`${command} takes no positional arguments but got: ${args.positionals.join(', ')}`
		);
	}
}
