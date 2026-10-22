/**
 * Which Convex deployment a local script talks to, resolved once so the CLI
 * (`convex env`) and plain HTTP requests (the seed routes) cannot end up on
 * two different backends.
 *
 * A checkout that has run `bun run dev:stack` has a stage `.env.local` naming
 * its self-hosted backend; that wins, and both the CLI and HTTP use it. A
 * checkout without one keeps the previous behaviour: the CLI runs in
 * `apps/api` with whatever deployment that directory selects.
 */

import { join } from 'node:path';
import { readEnvFile } from './envFile';
import { devStackPaths } from './state';

/** Variables the Convex CLI reads to pick a deployment. */
const CONVEX_SELECTION_KEYS = [
	'CONVEX_DEPLOYMENT',
	'CONVEX_DEPLOY_KEY',
	'CONVEX_SELF_HOSTED_URL',
	'CONVEX_SELF_HOSTED_ADMIN_KEY',
] as const;

export interface ConvexTarget {
	readonly source: 'dev-stack' | 'apps/api';
	/** Working directory for `convex` CLI calls. */
	readonly apiDir: string;
	/** Base URL for HTTP routes (`/seed/*`, `/dev/reset`). */
	readonly siteUrl: string;
	/** Environment for `convex` CLI calls. */
	readonly cliEnv: NodeJS.ProcessEnv;
}

/**
 * Environment for a Convex CLI call against a self-hosted backend. Selection
 * variables inherited from the shell or from a repository `.env` (Bun loads
 * those automatically) are dropped: the CLI refuses to run when it sees both
 * a cloud deployment and a self-hosted URL.
 */
export function selfHostedCliEnv(
	base: NodeJS.ProcessEnv,
	url: string,
	adminKey: string
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const key of CONVEX_SELECTION_KEYS) delete env[key];
	env['CONVEX_SELF_HOSTED_URL'] = url;
	env['CONVEX_SELF_HOSTED_ADMIN_KEY'] = adminKey;
	return env;
}

export function resolveConvexTarget(root: string, env: NodeJS.ProcessEnv): ConvexTarget {
	const paths = devStackPaths(root);
	const stage = readEnvFile(paths.stageEnv);
	const url = stage['CONVEX_SELF_HOSTED_URL'];
	const adminKey = stage['CONVEX_SELF_HOSTED_ADMIN_KEY'];
	const stageSite = stage['CONVEX_SITE_URL'];
	if (url && adminKey && stageSite) {
		return {
			source: 'dev-stack',
			apiDir: paths.stageApi,
			siteUrl: stageSite.replace(/\/$/, ''),
			cliEnv: selfHostedCliEnv(env, url, adminKey),
		};
	}
	const apiEnv = readEnvFile(join(paths.apiDir, '.env.local'));
	const siteUrl = env['CONVEX_SITE_URL'] ?? apiEnv['CONVEX_SITE_URL'] ?? 'http://127.0.0.1:3211';
	return {
		source: 'apps/api',
		apiDir: paths.apiDir,
		siteUrl: siteUrl.replace(/\/$/, ''),
		cliEnv: env,
	};
}
