/* eslint-disable no-console */
/**
 * `owlat-setup env` — inspect or set the install's `.env` file.
 *
 *   owlat-setup env <KEY> <VALUE>   Set a single variable (validated; secrets masked in output).
 *   owlat-setup env --show          List the env vars the deployment's CURRENT feature-flag state
 *                                   requires, whether each is set (secrets masked), and which flag
 *                                   requires it. This is `doctor`'s required-vars computation
 *                                   without the docker / health probing.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import pc from 'picocolors';
import {
	FEATURE_FLAGS,
	getRequiredEnvVars,
	getSendPathRequiredEnv,
	needsDeliveryProvider,
	resolveFlags,
	type FeatureFlagState,
} from '@owlat/shared/featureFlags';
import { readEnv, writeEnv, type EnvMap } from '../lib/env';
import { loadFlagState } from '../lib/flagState';

interface EnvCmdOptions {
	owlatDir: string;
	positional: string[];
	args?: string[];
}

/** True for keys whose values are secret and must be masked in any printed output. */
export function isSecretKey(key: string): boolean {
	return key.endsWith('_KEY') || key.endsWith('_SECRET') || key.endsWith('_PASSWORD');
}

/**
 * Render a value for display: secret keys collapse to a fixed-length stand-in so
 * credentials never print; everything else is shown verbatim. Shared by the
 * `env <KEY> <VALUE>` setter and `env --show`.
 */
export function maskSecretValue(key: string, value: string): string {
	return isSecretKey(key) ? '*'.repeat(Math.min(value.length, 8)) + '…' : value;
}

/** One row of `env --show`: a required var, whether it is set, its (masked) value, and why it is required. */
export interface EnvShowRow {
	key: string;
	/** Whether the var is present and non-empty in `.env`. */
	set: boolean;
	/** Display value: masked for secrets, verbatim otherwise, `(unset)` when absent. */
	masked: string;
	/** Human-readable reason(s) this var is required — flag key(s) and/or the send path. */
	requiredBy: string;
}

/**
 * Pure decision behind `env --show` (no IO): given the stored flag state and a
 * deployment env map, return one row per env var the CURRENT flag posture
 * requires. Reuses `getRequiredEnvVars` for the canonical (sorted, deduped)
 * required set and mirrors its send-path fold-in to attribute each var to the
 * flag(s) — or the provider-conditional send path — that demand it. Extracted
 * from `runEnvShow` so the table is unit-testable without the Bun runtime.
 */
export function computeEnvShowRows(
	flags: FeatureFlagState,
	env: EnvMap,
	opts: { deliveryProvider?: string } = {},
): EnvShowRow[] {
	const resolved = resolveFlags(flags);
	const requiredBy = new Map<string, string[]>();
	const attribute = (key: string, reason: string): void => {
		const list = requiredBy.get(key);
		if (list) list.push(reason);
		else requiredBy.set(key, [reason]);
	};

	for (const def of Object.values(FEATURE_FLAGS)) {
		if (!resolved[def.key]) continue;
		for (const v of def.requiredEnvVars ?? []) attribute(v, def.key);
	}
	const provider = opts.deliveryProvider;
	if (provider && needsDeliveryProvider(flags)) {
		for (const v of getSendPathRequiredEnv(provider)) attribute(v, `send path (EMAIL_PROVIDER=${provider})`);
	}

	return getRequiredEnvVars(flags, { deliveryProvider: provider }).map((key) => {
		const reason = (requiredBy.get(key) ?? []).join(', ');
		const value = env[key];
		if (value === undefined || value === '') {
			return { key, set: false, masked: '(unset)', requiredBy: reason };
		}
		return { key, set: true, masked: maskSecretValue(key, value), requiredBy: reason };
	});
}

/**
 * `owlat-setup env --show` — print the required-env table for the current
 * feature-flag state. Reads the local `.env` and `.owlat-flags.json` mirror,
 * delegates the decision to `computeEnvShowRows`, and renders an aligned table.
 * Always exits `0` (it is a read-only listing, not a health check — use
 * `owlat doctor` for a pass/fail gate).
 */
async function runEnvShow(opts: EnvCmdOptions): Promise<number> {
	const envPath = join(opts.owlatDir, '.env');
	const env: EnvMap = existsSync(envPath) ? await readEnv(envPath) : {};
	const flags = await loadFlagState(opts.owlatDir);
	const rows = computeEnvShowRows(flags, env, { deliveryProvider: env['EMAIL_PROVIDER'] });

	if (rows.length === 0) {
		console.log('No environment variables are required by the current feature-flag state.');
		return 0;
	}

	const keyWidth = Math.max(3, ...rows.map((r) => r.key.length));
	const valWidth = Math.max(11, ...rows.map((r) => r.masked.length));
	const header = `  ${'KEY'.padEnd(keyWidth)}  ${'SET / VALUE'.padEnd(valWidth)}  REQUIRED BY`;
	console.log(pc.bold(header));
	console.log(pc.dim('─'.repeat(header.length)));

	let missing = 0;
	for (const row of rows) {
		if (!row.set) missing++;
		const mark = row.set ? pc.green('✓') : pc.red('✗');
		const keyCol = row.key.padEnd(keyWidth);
		const valCol = row.masked.padEnd(valWidth);
		const valColored = row.set ? valCol : pc.red(valCol);
		console.log(`${mark} ${keyCol}  ${valColored}  ${pc.dim(row.requiredBy)}`);
	}

	console.log();
	if (missing === 0) {
		console.log(pc.green(`All ${rows.length} required variable(s) are set.`));
	} else {
		console.log(
			pc.yellow(
				`${missing} of ${rows.length} required variable(s) are unset. Set one with \`owlat-setup env <KEY> <VALUE>\`.`,
			),
		);
	}
	return 0;
}

export async function runEnv(opts: EnvCmdOptions): Promise<number> {
	if (opts.args?.includes('--show')) {
		return runEnvShow(opts);
	}

	const [key, ...valueParts] = opts.positional;
	if (!key || valueParts.length === 0) {
		console.error('Usage: owlat-setup env <KEY> <VALUE>   (or: owlat-setup env --show)');
		return 1;
	}

	if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
		console.error(`Invalid env var name: ${key} (must be uppercase identifier).`);
		return 1;
	}

	const value = valueParts.join(' ');
	const envPath = join(opts.owlatDir, '.env');
	const existing = await readEnv(envPath);
	existing[key] = value;
	await writeEnv(envPath, existing);

	console.log(`${pc.green('✓')} ${key} = ${maskSecretValue(key, value)}`);
	console.log(`\nRun ${pc.cyan('owlat restart')} to apply.`);
	return 0;
}
