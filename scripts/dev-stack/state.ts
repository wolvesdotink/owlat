/**
 * The dev stack's files inside one checkout. Everything lives under
 * `.owlat-dev/` (gitignored by the `/.owlat-*` rule), so the repository env
 * files, which a worktree may share with the main checkout through a symlink,
 * never receive this checkout's ports or credentials.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DevStackConfig } from './config';

export const STATE_DIR = '.owlat-dev';

export interface DevStackPaths {
	readonly stateDir: string;
	readonly secretsFile: string;
	/** Interpolation values for `docker compose` (ports and secrets). */
	readonly composeEnv: string;
	readonly composeFile: string;
	/** Convex project the stack pushes from (see stage.ts). */
	readonly stageApi: string;
	/** The stage's `.env.local`: the Convex CLI's deployment selection. */
	readonly stageEnv: string;
	readonly apiDir: string;
}

export function devStackPaths(root: string): DevStackPaths {
	const stateDir = join(root, STATE_DIR);
	const stageApi = join(stateDir, 'api');
	return {
		stateDir,
		secretsFile: join(stateDir, 'secrets.json'),
		composeEnv: join(stateDir, 'compose.env'),
		composeFile: join(root, 'docker', 'dev-stack.compose.yml'),
		stageApi,
		stageEnv: join(stageApi, '.env.local'),
		apiDir: join(root, 'apps', 'api'),
	};
}

export interface DevStackSecrets {
	/**
	 * One secret for both the Convex backend container (it derives the admin
	 * key from it, so it must be 32 bytes of hex) and Owlat's own
	 * `INSTANCE_SECRET` deployment variable, as a self-hosted `.env` does.
	 */
	readonly instanceSecret: string;
	readonly betterAuthSecret: string;
	readonly redisPassword: string;
}

const SECRET_KEYS = ['instanceSecret', 'betterAuthSecret', 'redisPassword'] as const;

function isHexSecret(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Reads this checkout's secrets, generating any that are missing. They are
 * created once and kept, so the admin key, sessions and the Redis password
 * survive restarts as long as the Compose volumes do.
 */
export function loadOrCreateSecrets(
	file: string,
	random: (bytes: number) => Buffer = randomBytes
): DevStackSecrets {
	let stored: Record<string, unknown> = {};
	if (existsSync(file)) {
		try {
			stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
		} catch {
			throw new Error(`${file} is not valid JSON. Fix or delete it (a new one is generated).`);
		}
	}
	const secrets: Record<string, string> = {};
	let changed = false;
	for (const key of SECRET_KEYS) {
		const value = stored[key];
		if (isHexSecret(value)) {
			secrets[key] = value;
		} else {
			secrets[key] = random(32).toString('hex');
			changed = true;
		}
	}
	if (changed) {
		mkdirSync(join(file, '..'), { recursive: true });
		writeFileSync(file, `${JSON.stringify(secrets, null, '\t')}\n`, { mode: 0o600 });
	}
	return secrets as unknown as DevStackSecrets;
}

/** Values `docker/dev-stack.compose.yml` interpolates. */
export function composeEnvEntries(
	config: DevStackConfig,
	secrets: DevStackSecrets
): Record<string, string> {
	return {
		OWLAT_DEV_CONVEX_PORT: String(config.ports.convex),
		OWLAT_DEV_CONVEX_SITE_PORT: String(config.ports.convexSite),
		OWLAT_DEV_REDIS_PORT: String(config.ports.redis),
		OWLAT_DEV_CONVEX_URL: config.urls.convex,
		OWLAT_DEV_CONVEX_SITE_URL: config.urls.convexSite,
		OWLAT_DEV_INSTANCE_SECRET: secrets.instanceSecret,
		OWLAT_DEV_REDIS_PASSWORD: secrets.redisPassword,
	};
}

/** Deployment variables the stack owns besides the URL ones (config.ts). */
export function deploymentSecretEnv(secrets: DevStackSecrets): Record<string, string> {
	return {
		INSTANCE_SECRET: secrets.instanceSecret,
		BETTER_AUTH_SECRET: secrets.betterAuthSecret,
		// Opens /seed and /dev/reset; dev:seed sets it too. A local stack only.
		OWLAT_DEV_MODE: 'true',
	};
}
