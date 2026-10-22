/**
 * The order `bun run dev:stack` brings a checkout's stack up in. Every side
 * effect goes through `StackOps`, so the sequence (and what stops it) is
 * tested without Docker; scripts/dev-stack.ts supplies the real operations.
 */

import {
	DevStackConfigError,
	OFFSET_MIN,
	OFFSET_STRIDE,
	describePorts,
	deploymentUrlEnv,
	type DevService,
	type DevStackConfig,
} from './config';
import { deploymentSecretEnv, type DevStackSecrets } from './state';
import type { SyncResult } from './stage';

export interface UpOptions {
	/** Run `dev:seed` after the first push (default on; it is idempotent). */
	readonly seed: boolean;
}

export interface StackOps {
	log(line: string): void;
	/** Compose services of this checkout's project that are running now. */
	runningServices(): Promise<ReadonlySet<string>>;
	portInUse(port: number): Promise<boolean>;
	composeUp(): Promise<void>;
	adminKey(): Promise<string>;
	syncStage(): SyncResult;
	writeStageEnv(entries: Record<string, string>): void;
	setDeploymentEnv(entries: Record<string, string>): Promise<void>;
	/** One `convex dev --once` push; rejects when the push fails. */
	pushOnce(): Promise<void>;
	seed(): Promise<void>;
	/** Starts the watchers and Nuxt; resolves with the exit code once they stop. */
	runForeground(): Promise<number>;
}

/** Host ports bound by each Compose service. */
const CONTAINER_PORTS: Record<string, DevService[]> = {
	convex: ['convex', 'convexSite'],
	redis: ['redis'],
};

function nextOffsetHint(config: DevStackConfig): number {
	return config.offset === 0 ? OFFSET_MIN : config.offset + OFFSET_STRIDE;
}

/**
 * Ports that are taken by something other than this checkout's own running
 * containers. Hashing cannot rule out two checkouts landing on the same
 * offset, so this runs before anything binds.
 */
export async function findPortConflicts(
	config: DevStackConfig,
	ops: Pick<StackOps, 'runningServices' | 'portInUse'>
): Promise<string[]> {
	const running = await ops.runningServices();
	const toCheck: DevService[] = ['web'];
	for (const [service, ports] of Object.entries(CONTAINER_PORTS)) {
		if (!running.has(service)) toCheck.push(...ports);
	}
	const conflicts: string[] = [];
	for (const service of toCheck) {
		if (await ops.portInUse(config.ports[service])) {
			conflicts.push(`${service} port ${config.ports[service]}`);
		}
	}
	return conflicts;
}

export async function runUp(
	config: DevStackConfig,
	secrets: DevStackSecrets,
	options: UpOptions,
	ops: StackOps
): Promise<number> {
	ops.log(describePorts(config));

	const conflicts = await findPortConflicts(config, ops);
	if (conflicts.length > 0) {
		throw new DevStackConfigError(
			[
				`Already in use: ${conflicts.join(', ')}.`,
				'Another checkout may have hashed to the same ports, or another server is running there.',
				`Pick a different offset, for example: OWLAT_PORT_OFFSET=${nextOffsetHint(config)} bun run dev:stack`,
			].join('\n')
		);
	}

	ops.log('Starting the Convex backend and Redis...');
	await ops.composeUp();
	const adminKey = await ops.adminKey();

	const synced = ops.syncStage();
	ops.log(`Staged apps/api for Convex (${synced.copied} copied, ${synced.removed} removed).`);
	ops.writeStageEnv({
		CONVEX_SELF_HOSTED_URL: config.urls.convex,
		CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
		CONVEX_SITE_URL: config.urls.convexSite,
	});
	await ops.setDeploymentEnv({ ...deploymentSecretEnv(secrets), ...deploymentUrlEnv(config) });

	ops.log('Pushing Convex functions (the first push takes a minute or two)...');
	await ops.pushOnce();
	if (options.seed) {
		ops.log('Seeding demo accounts and data (bun run dev:seed)...');
		await ops.seed();
	}
	ops.log(`Starting the Convex watcher and Nuxt; the app will be at ${config.urls.web}`);
	return ops.runForeground();
}
