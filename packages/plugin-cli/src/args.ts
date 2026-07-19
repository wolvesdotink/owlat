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
			const value = inlineValue ?? argv[(index += 1)];
			if (value === undefined) throw new PluginCliError(`--${name} requires a value`);
			values.set(name, value);
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
