/* eslint-disable no-console */
/**
 * `owlat-setup push-env` — push the Convex function-runtime keys from `.env`
 * into the running deployment. The second half of `owlat apply`.
 *
 * Provider credentials, `EMAIL_PROVIDER`, `LLM_*` and the rest of
 * `CONVEX_RUNTIME_ENV_KEYS` are read by Convex functions from the deployment's
 * env store, not from any container's environment. `owlat env` only writes
 * `.env`, and recreating containers pushes nothing, so without this step an
 * edited credential never reaches the code that uses it.
 *
 * Same selection and the same push as the `runtime-env` stage of `owlat
 * quickstart`: `selectRuntimeEnvVars` (which unseals secrets sealed at rest in
 * `.env` and fails closed on a token it cannot open) and `setConvexEnvVars`
 * (`convex env set` inside the `convex-deploy` container, which needs the
 * Docker socket and the admin key from `.env`).
 */

import pc from 'picocolors';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readEnv } from '../lib/env';
import { looksLikeRealAdminKey, selectRuntimeEnvVars, setConvexEnvVars } from '../lib/convexDeploy';

interface PushEnvOptions {
	owlatDir: string;
}

export async function runPushEnv(opts: PushEnvOptions): Promise<number> {
	const envPath = join(opts.owlatDir, '.env');
	if (!existsSync(envPath)) {
		console.error(
			`${pc.red('✗')} No .env in ${opts.owlatDir}, so there is nothing to push. Run ${pc.cyan('owlat quickstart')} first.`
		);
		return 1;
	}
	const env = await readEnv(envPath);

	// `convex env set` authenticates with the backend-issued admin key. Without
	// one the push would fail deep inside the container with an auth error, so
	// say what is missing and how to get it instead.
	if (!looksLikeRealAdminKey(env['CONVEX_ADMIN_KEY'])) {
		console.error(
			`${pc.yellow('!')} Function-runtime keys were NOT pushed: .env has no Convex admin key (CONVEX_ADMIN_KEY).\n` +
				`  Run ${pc.cyan('owlat quickstart')} — it mints the key and pushes these keys as its last step.`
		);
		return 1;
	}

	let vars: Array<[string, string]>;
	try {
		vars = selectRuntimeEnvVars(env);
	} catch (e) {
		console.error(`${pc.red('✗')} ${(e as Error).message}`);
		return 1;
	}
	if (vars.length === 0) {
		console.log(`${pc.dim('No function-runtime keys are set in .env — nothing to push.')}`);
		return 0;
	}

	try {
		await setConvexEnvVars(opts.owlatDir, vars, (line) => console.log(pc.dim(`  ${line}`)));
	} catch (e) {
		console.error(`${pc.red('✗')} ${(e as Error).message}`);
		return 1;
	}
	console.log(
		`${pc.green('✓')} Pushed ${vars.length} function-runtime key(s) to the Convex deployment.`
	);
	return 0;
}
