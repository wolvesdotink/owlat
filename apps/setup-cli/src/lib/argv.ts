/**
 * Argument parsing for the top-level dispatcher (`src/index.ts`): splits the
 * argv tail after the command name into flags, option values and positional
 * arguments, then resolves the options every command receives.
 *
 * Options that take a value are listed in `VALUE_OPTIONS`; each one consumes
 * the next token (or its `--opt=value` suffix), so the value never reaches
 * `positional`. Without that, `env KEY VALUE --owlat-dir DIR` wrote
 * `KEY=VALUE DIR` and `env --owlat-dir DIR KEY VALUE` took DIR as the key.
 * A new option that takes a value must be added here, even when only one
 * command reads it from the raw `args`.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CliOptions } from './cliOptions';

export const VALUE_OPTIONS: ReadonlySet<string> = new Set([
	'--config',
	'--email',
	'--mode',
	'--name',
	'--owlat-dir',
	'--owlat-version',
	'--password',
]);

export interface ParsedArgv {
	/** Value-less `--flag` tokens, plus `-y`. */
	flags: Set<string>;
	/** Value of each `VALUE_OPTIONS` entry (or `--opt=value` token) given. */
	values: Map<string, string>;
	/** Everything that is neither a flag, an option nor an option's value. */
	positional: string[];
}

export function parseArgv(args: readonly string[]): ParsedArgv {
	const flags = new Set<string>();
	const values = new Map<string, string>();
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === '-y') {
			flags.add(arg);
		} else if (!arg.startsWith('--')) {
			positional.push(arg);
		} else if (arg.includes('=')) {
			const eq = arg.indexOf('=');
			values.set(arg.slice(0, eq), arg.slice(eq + 1));
		} else if (VALUE_OPTIONS.has(arg)) {
			// Same rule as the per-command parsers (`quickstart`, `bootstrap-org`):
			// the next token is the value, whatever it looks like.
			const value = args[i + 1];
			if (value !== undefined) values.set(arg, value);
			i++;
		} else {
			flags.add(arg);
		}
	}
	return { flags, values, positional };
}

export interface DispatchOptions extends CliOptions {
	buildLocal: boolean;
	localImages: boolean;
	owlatVersion?: string;
}

/** The options `src/index.ts` hands to every command, from the argv tail. */
export function cliOptionsFromArgv(
	args: string[],
	env: NodeJS.ProcessEnv = process.env
): DispatchOptions {
	const { flags, values, positional } = parseArgv(args);
	return {
		web: flags.has('--web'),
		terminal: flags.has('--terminal'),
		assumeYes: flags.has('--assume-yes') || flags.has('-y'),
		// Local-source installs (the desktop dev flow forwards these through
		// scripts/owlat): compose builds images from this tree (buildLocal) or
		// uses pre-pushed dev images as-is (localImages).
		buildLocal: flags.has('--build-local') || env['OWLAT_BUILD_LOCAL'] === '1',
		localImages: flags.has('--local-images') || env['OWLAT_LOCAL_IMAGES'] === '1',
		// Release version resolved by install.sh (the `curl | bash` PULL path), so
		// quickstart can pin `OWLAT_VERSION=<semver>` into .env and compose pulls
		// the signed release images. Passed as a flag (not an env var) so it never
		// leaks into the containerized compose interpolation and overrides .env.
		owlatVersion: values.get('--owlat-version'),
		owlatDir: values.get('--owlat-dir') ?? env['OWLAT_DIR'] ?? defaultOwlatDir(),
		configFile: values.get('--config'),
		positional,
		// The full argv tail, so commands with their own flags (`quickstart`,
		// `bootstrap-org`, `seed`, `env --show`) can scan the raw list.
		args,
	};
}

/**
 * Default owlat directory: walk up from the current working directory looking
 * for a `turbo.json` (monorepo root). Falls back to `/opt/owlat` for the
 * legacy VPS install layout.
 */
function defaultOwlatDir(): string {
	let dir = process.cwd();
	for (let i = 0; i < 12; i++) {
		if (existsSync(join(dir, 'turbo.json'))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return '/opt/owlat';
}
