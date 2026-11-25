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
	webEnv,
	type DevService,
	type DevStackConfig,
} from './config';
import { deploymentSecretEnv, type DevStackSecrets } from './state';
import type { SyncResult } from './stage';

export interface UpOptions {
	/** Run `dev:seed` after the first push (default on; it is idempotent). */
	readonly seed: boolean;
	/**
	 * Run Nuxt (default on). Off, the deployment still trusts the web port, so
	 * a Nuxt started by hand there (the desktop app's `tauri dev`) signs in.
	 */
	readonly web: boolean;
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
	/** Starts the watchers and Nuxt (when `web`); resolves with the exit code once they stop. */
	runForeground(web: boolean): Promise<number>;
}

export interface CodegenOps extends Omit<
	StackOps,
	'pushOnce' | 'seed' | 'runForeground' | 'writeStageEnv'
> {
	/** `convex codegen` in the stage; rejects when it fails. */
	codegen(): Promise<void>;
	/**
	 * Copies the stage's generated files, with the api declaration chunked,
	 * into apps/api; returns how many changed.
	 */
	copyGeneratedBack(): number;
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
	ops: Pick<StackOps, 'runningServices' | 'portInUse'>,
	options: Pick<UpOptions, 'web'> = { web: true }
): Promise<string[]> {
	const running = await ops.runningServices();
	const toCheck: DevService[] = options.web ? ['web'] : [];
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

/**
 * Starts the containers (a no-op when they run), stages apps/api and points
 * the stage and the deployment at each other. Shared by `up` and `codegen`,
 * so codegen works whether or not the foreground stack is running.
 */
async function prepareBackend(
	config: DevStackConfig,
	secrets: DevStackSecrets,
	ops: Omit<StackOps, 'pushOnce' | 'seed' | 'runForeground' | 'writeStageEnv'> &
		Partial<Pick<StackOps, 'writeStageEnv'>>,
	options: Pick<UpOptions, 'web'>
): Promise<void> {
	const conflicts = await findPortConflicts(config, ops, options);
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
	// `dev:seed` targets whatever the stage env names (convexTarget.ts), so only
	// `up`, which also pushes the functions, writes it.
	ops.writeStageEnv?.({
		CONVEX_SELF_HOSTED_URL: config.urls.convex,
		CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
		CONVEX_SITE_URL: config.urls.convexSite,
	});
	await ops.setDeploymentEnv({ ...deploymentSecretEnv(secrets), ...deploymentUrlEnv(config) });
}

export async function runUp(
	config: DevStackConfig,
	secrets: DevStackSecrets,
	options: UpOptions,
	ops: StackOps
): Promise<number> {
	ops.log(describePorts(config));
	await prepareBackend(config, secrets, ops, options);

	ops.log('Pushing Convex functions (the first push takes a minute or two)...');
	await ops.pushOnce();
	if (options.seed) {
		ops.log('Seeding demo accounts and data (bun run dev:seed)...');
		await ops.seed();
	}
	if (options.web) {
		ops.log(`Starting the Convex watcher and Nuxt; the app will be at ${config.urls.web}`);
	} else {
		const nuxtEnv = webEnv(config);
		ops.log(
			[
				'Starting the Convex watcher without Nuxt (--no-web). Start your own Nuxt with:',
				`  NUXT_PORT=${nuxtEnv['NUXT_PORT']} NUXT_PUBLIC_SITE_URL=${nuxtEnv['NUXT_PUBLIC_SITE_URL']} ` +
					`NUXT_PUBLIC_CONVEX_URL=${nuxtEnv['NUXT_PUBLIC_CONVEX_URL']} ` +
					`NUXT_PUBLIC_CONVEX_SITE_URL=${nuxtEnv['NUXT_PUBLIC_CONVEX_SITE_URL']}`,
			].join('\n')
		);
	}
	return ops.runForeground(options.web);
}

/**
 * `convex codegen` for apps/api. The CLI cannot generate offline: it bundles
 * the modules and sends them to a backend as an uncommitted push to learn the
 * component APIs. It runs in the stage because bundling apps/api itself fails
 * on the Node-only helpers in `__tests__`, and only ever against this
 * checkout's own backend, never a deployment apps/api or the shell selects.
 * Nothing is deployed: the push is never finished.
 */
export async function runCodegen(
	config: DevStackConfig,
	secrets: DevStackSecrets,
	ops: CodegenOps
): Promise<number> {
	await prepareBackend(config, secrets, { ...ops, writeStageEnv: undefined }, { web: false });
	ops.log('Running convex codegen in the stage...');
	await ops.codegen();
	const changed = ops.copyGeneratedBack();
	ops.log(
		changed === 0
			? 'Generated files are up to date.'
			: `Copied ${changed} generated file(s) into apps/api/convex.`
	);
	return 0;
}
