/* eslint-disable no-console */
/**
 * `owlat-setup unset-env <KEY...>` — clear Convex function-runtime keys from
 * the running deployment AND from `.env`. Run by `owlat unset-env`.
 *
 * `push-env` (and so `owlat apply`) is additive: it sets every runtime key that
 * has a value in `.env` and never deletes one, so blanking or deleting a line
 * in `.env` leaves the old value live in the deployment. This is the explicit
 * way to clear one, restricted to `CONVEX_RUNTIME_ENV_KEYS`. Named-transport
 * (`<BASE>__<INSTANCE>`) and plugin variables are not in that catalog and are
 * managed by their own flows, so they are refused here.
 *
 * Order: every check runs first, and nothing changes when one fails. The
 * deployment is cleared next and `.env` last, so a backend failure leaves
 * `.env` as it was for the keys still set in the deployment. Clearing `.env`
 * first would let a failed run leave the deployment holding a value that no
 * later `apply` replaces; clearing the deployment and then failing to write
 * `.env` would let the next `apply` push the value straight back, which is
 * why that case is reported as a failure.
 */

import pc from 'picocolors';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { projectCanonicalMtaRuntimeEnv } from '@owlat/shared/outboundIdentity';
import { readEnv, writeEnv, type EnvMap } from '../lib/env';
import {
	CONVEX_RUNTIME_ENV_KEYS,
	ConvexEnvRemoveError,
	looksLikeRealAdminKey,
	removeConvexEnvVars,
} from '../lib/convexDeploy';

interface UnsetEnvOptions {
	owlatDir: string;
	positional: string[];
}

/**
 * Runtime keys every install needs: auth sessions, the instance secret that
 * seals stored credentials, and the public URL. Clearing one breaks sign-in or
 * opening stored secrets, so they can be replaced with `owlat env` but not
 * unset.
 */
const REQUIRED_RUNTIME_KEYS: ReadonlySet<string> = new Set([
	'BETTER_AUTH_SECRET',
	'INSTANCE_SECRET',
	'SITE_URL',
]);

const RUNTIME_KEYS: ReadonlySet<string> = new Set(CONVEX_RUNTIME_ENV_KEYS);

/**
 * Why `key` cannot be unset, or `null` when it can. Pure, so the catalog rules
 * are testable without Docker.
 */
export function unsetEnvRefusal(key: string): string | null {
	if (!RUNTIME_KEYS.has(key)) {
		if (key.includes('__') || key.startsWith('PLUGIN_')) {
			return `${key} is not one of the runtime keys \`owlat apply\` pushes. Named transport instances (<KEY>__<INSTANCE>) and plugin (PLUGIN_*) variables are set in the Convex env store directly; remove them there with \`convex env remove\`.`;
		}
		return `${key} is not one of the Convex function-runtime keys \`owlat apply\` pushes, so the deployment does not get it from .env. Remove it from .env with an editor.`;
	}
	if (REQUIRED_RUNTIME_KEYS.has(key)) {
		return `${key} is required by every install and cannot be unset. Set a new value with \`owlat env ${key} <VALUE>\` and run \`owlat apply\`.`;
	}
	return null;
}

/**
 * The requested keys `push-env` would still push once they are gone from
 * `.env`, because they are derived from other `.env` settings (`MTA_IP_POOLS`
 * from `IP_POOLS_*`, `MTA_RETURN_PATH_DOMAIN` from `RETURN_PATH_DOMAIN`,
 * `MTA_BOUNCE_VERP_KEY` from `BOUNCE_VERP_KEY`). Unsetting one of those would
 * only last until the next `owlat apply`.
 */
export function derivedRuntimeKeys(env: EnvMap, keys: readonly string[]): string[] {
	const remaining: EnvMap = { ...env };
	for (const key of keys) delete remaining[key];
	let projected: EnvMap;
	try {
		projected = projectCanonicalMtaRuntimeEnv(remaining);
	} catch {
		// An unparsable source setting makes push-env fail as well, so it cannot
		// push the key back either.
		return [];
	}
	return keys.filter((key) => projected[key] !== undefined && projected[key] !== '');
}

export async function runUnsetEnv(opts: UnsetEnvOptions): Promise<number> {
	const keys = [...new Set(opts.positional)];
	if (keys.length === 0) {
		console.error('Usage: owlat-setup unset-env <KEY> [KEY...]');
		return 1;
	}

	const refusals = keys.flatMap((key) => {
		const reason = unsetEnvRefusal(key);
		return reason ? [reason] : [];
	});
	if (refusals.length > 0) {
		for (const reason of refusals) console.error(`${pc.red('✗')} ${reason}`);
		console.error(`  Nothing was changed.`);
		return 1;
	}

	const envPath = join(opts.owlatDir, '.env');
	if (!existsSync(envPath)) {
		console.error(
			`${pc.red('✗')} No .env in ${opts.owlatDir}. Nothing was changed. Run ${pc.cyan('owlat quickstart')} first.`
		);
		return 1;
	}
	const env = await readEnv(envPath);

	// `convex env remove` authenticates with the backend-issued admin key, the
	// same one `push-env` needs.
	if (!looksLikeRealAdminKey(env['CONVEX_ADMIN_KEY'])) {
		console.error(
			`${pc.yellow('!')} Nothing was changed: .env has no Convex admin key (CONVEX_ADMIN_KEY), so the deployment cannot be updated.\n` +
				`  Run ${pc.cyan('owlat quickstart')} to mint the key, then run this command again.`
		);
		return 1;
	}

	const derived = derivedRuntimeKeys(env, keys);
	if (derived.length > 0) {
		console.error(
			`${pc.red('✗')} ${derived.join(', ')} ${derived.length === 1 ? 'is' : 'are'} derived from other settings in .env (IP_POOLS_*, RETURN_PATH_DOMAIN or BOUNCE_VERP_KEY), so the next ${pc.cyan('owlat apply')} would push ${derived.length === 1 ? 'it' : 'them'} again.\n` +
				`  Change or remove the source setting instead. Nothing was changed.`
		);
		return 1;
	}

	let removed = keys;
	let failure: ConvexEnvRemoveError | null = null;
	try {
		await removeConvexEnvVars(opts.owlatDir, keys, (line) => console.log(pc.dim(`  ${line}`)));
	} catch (e) {
		if (!(e instanceof ConvexEnvRemoveError)) throw e;
		failure = e;
		removed = e.removed;
	}

	// Drop from .env only what the deployment confirmed, so `.env` keeps
	// matching the deployment for anything still set there.
	const inEnv = removed.filter((key) => key in env);
	let envWriteError: Error | null = null;
	if (inEnv.length > 0) {
		const next: EnvMap = { ...env };
		for (const key of inEnv) delete next[key];
		try {
			await writeEnv(envPath, next);
		} catch (e) {
			envWriteError = e as Error;
		}
	}

	if (failure) {
		const remaining = keys.filter((key) => !removed.includes(key));
		console.error(`${pc.red('✗')} ${failure.message}`);
		if (removed.length > 0) {
			console.error(`  Removed from the deployment: ${removed.join(', ')}`);
		}
		console.error(
			`  Not removed (the deployment and .env are unchanged for these): ${remaining.join(', ')}\n` +
				`  Run ${pc.cyan(`owlat unset-env ${remaining.join(' ')}`)} again once the backend is reachable.`
		);
	}
	if (envWriteError) {
		const them = inEnv.length === 1 ? 'it' : 'them';
		console.error(
			`${pc.red('✗')} Removed ${inEnv.join(', ')} from the Convex deployment, but could not update .env: ${envWriteError.message}\n` +
				`  .env still sets ${them}, so the next ${pc.cyan('owlat apply')} would push ${them} back. Fix the file and run ${pc.cyan(`owlat unset-env ${inEnv.join(' ')}`)} again.`
		);
	}
	if (failure || envWriteError) return 1;

	console.log(
		`${pc.green('✓')} Unset ${keys.join(', ')} in the Convex deployment${inEnv.length > 0 ? ' and .env' : ''}.`
	);
	return 0;
}
