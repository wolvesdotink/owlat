/**
 * The order `bun run dev:stack` brings a stack up in (scripts/dev-stack/up.ts),
 * driven through fake operations: what runs, what it is given, and what a
 * failure stops.
 */

import { describe, expect, it } from 'vitest';
import { DevStackConfigError, resolveDevStackConfig } from '../dev-stack/config';
import { findPortConflicts, runUp, type StackOps } from '../dev-stack/up';

const config = resolveDevStackConfig({ root: '/work/wt', linkedWorktree: true, explicit: '20000' });
const secrets = {
	instanceSecret: 'i'.repeat(64),
	betterAuthSecret: 'b'.repeat(64),
	redisPassword: 'r',
};

interface Fake {
	ops: StackOps;
	calls: string[];
	stageEnv: Record<string, string>;
	deploymentEnv: Record<string, string>;
}

function fakeOps(
	overrides: Partial<StackOps> & { busy?: number[]; running?: string[] } = {}
): Fake {
	const calls: string[] = [];
	const fake: Fake = {
		ops: undefined as unknown as StackOps,
		calls,
		stageEnv: {},
		deploymentEnv: {},
	};
	const record =
		<T>(name: string, value: T) =>
		async () => {
			calls.push(name);
			return value;
		};
	fake.ops = {
		log: () => {},
		runningServices: async () => new Set(overrides.running ?? []),
		portInUse: async (port) => (overrides.busy ?? []).includes(port),
		composeUp: record('composeUp', undefined),
		adminKey: record('adminKey', 'convex-self-hosted|key'),
		syncStage: () => {
			calls.push('syncStage');
			return { copied: 1, removed: 0 };
		},
		writeStageEnv: (entries) => {
			calls.push('writeStageEnv');
			fake.stageEnv = entries;
		},
		setDeploymentEnv: async (entries) => {
			calls.push('setDeploymentEnv');
			fake.deploymentEnv = entries;
		},
		pushOnce: record('pushOnce', undefined),
		seed: record('seed', undefined),
		runForeground: record('runForeground', 0),
		...overrides,
	};
	return fake;
}

describe('runUp', () => {
	it('pushes before seeding and starts the watchers last', async () => {
		const fake = fakeOps();
		await expect(runUp(config, secrets, { seed: true }, fake.ops)).resolves.toBe(0);
		expect(fake.calls).toEqual([
			'composeUp',
			'adminKey',
			'syncStage',
			'writeStageEnv',
			'setDeploymentEnv',
			'pushOnce',
			'seed',
			'runForeground',
		]);
	});

	it('skips the seed with --no-seed', async () => {
		const fake = fakeOps();
		await runUp(config, secrets, { seed: false }, fake.ops);
		expect(fake.calls).not.toContain('seed');
		expect(fake.calls.at(-1)).toBe('runForeground');
	});

	it('starts nothing after a failed push', async () => {
		const fake = fakeOps({
			pushOnce: async () => {
				throw new Error('push failed');
			},
		});
		await expect(runUp(config, secrets, { seed: true }, fake.ops)).rejects.toThrow('push failed');
		expect(fake.calls).not.toContain('seed');
		expect(fake.calls).not.toContain('runForeground');
	});

	it('stops before the push when the backend cannot be started', async () => {
		const fake = fakeOps({
			composeUp: async () => {
				throw new Error('docker compose up failed');
			},
		});
		await expect(runUp(config, secrets, { seed: true }, fake.ops)).rejects.toThrow(/compose/);
		expect(fake.calls).toEqual([]);
	});

	it('points the CLI, the HTTP routes and the deployment at the same ports', async () => {
		const fake = fakeOps();
		await runUp(config, secrets, { seed: true }, fake.ops);
		expect(fake.stageEnv).toEqual({
			CONVEX_SELF_HOSTED_URL: 'http://127.0.0.1:23210',
			CONVEX_SELF_HOSTED_ADMIN_KEY: 'convex-self-hosted|key',
			CONVEX_SITE_URL: 'http://127.0.0.1:23211',
		});
		expect(fake.deploymentEnv).toEqual({
			INSTANCE_SECRET: secrets.instanceSecret,
			BETTER_AUTH_SECRET: secrets.betterAuthSecret,
			OWLAT_DEV_MODE: 'true',
			SITE_URL: 'http://localhost:23000',
			ALLOWED_ORIGINS: 'http://localhost:23000',
		});
	});

	it('refuses to start on a taken port and names an offset to try', async () => {
		const fake = fakeOps({ busy: [23000] });
		const failure = runUp(config, secrets, { seed: true }, fake.ops);
		await expect(failure).rejects.toThrow(DevStackConfigError);
		await expect(failure).rejects.toThrow(/web port 23000.*\n.*\n.*OWLAT_PORT_OFFSET=20013/s);
		expect(fake.calls).toEqual([]);
	});
});

describe('findPortConflicts', () => {
	it('ignores ports held by this checkout’s own running containers', async () => {
		const busy = [23210, 23211, 26379];
		expect(
			await findPortConflicts(config, fakeOps({ busy, running: ['convex', 'redis'] }).ops)
		).toEqual([]);
		expect(await findPortConflicts(config, fakeOps({ busy, running: ['redis'] }).ops)).toEqual([
			'convex port 23210',
			'convexSite port 23211',
		]);
	});

	it('always checks the web port, which no container owns', async () => {
		const ops = fakeOps({ busy: [23000], running: ['convex', 'redis'] }).ops;
		expect(await findPortConflicts(config, ops)).toEqual(['web port 23000']);
	});
});
