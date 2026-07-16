import { getFunctionName } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginCronServices } from '@owlat/plugin-kit';

const registry = vi.hoisted(() => ({
	catalog: [] as Array<{
		kind: string;
		pluginId: string;
		label: string;
		intervalMinutes: number;
		timeoutMs: number;
		requiredEnvVars: readonly string[];
		requiredCapability: 'scheduler:cron';
	}>,
	modules: [] as Array<{ kind: string; pluginId: string; module: unknown }>,
	llm: { generate: vi.fn() },
}));

vi.mock('../cronCatalog.generated', () => ({
	BUNDLED_PLUGIN_CRON_CATALOG: registry.catalog,
}));

vi.mock('../cronModules.generated', () => ({
	BUNDLED_PLUGIN_CRON_MODULES: registry.modules,
}));

vi.mock('../llm', () => ({
	bindSystemBundledPluginLlm: vi.fn(() => registry.llm),
}));

import { runPluginCron } from '../cronRuntime';

const handler = (
	runPluginCron as unknown as {
		_handler: (ctx: unknown, args: { pluginId: string; cronKind: string }) => Promise<void>;
	}
)._handler;

interface FixtureOptions {
	readonly authorized?: boolean;
	readonly authorizeThrows?: boolean;
	readonly auditThrows?: boolean;
}

function fixture(options: FixtureOptions = {}) {
	const calls: Array<{ name: string; args: unknown }> = [];
	const ctx = {
		runMutation: vi.fn(async (reference: unknown, args: unknown) => {
			const name = getFunctionName(reference as never);
			calls.push({ name, args });
			if (name.endsWith(':authorizeExecution')) {
				if (options.authorizeThrows) throw new Error('authorization outage');
				return options.authorized ?? true;
			}
			if (name.endsWith(':recordOutcome') && options.auditThrows) {
				throw new Error('audit detail must remain private');
			}
			return undefined;
		}),
	};
	return { ctx, calls };
}

function addCron(
	kind: string,
	run: (services: PluginCronServices) => unknown | Promise<unknown>,
	options: { pluginId?: string; timeoutMs?: number } = {}
) {
	const pluginId = options.pluginId ?? 'seed-lab';
	registry.catalog.push({
		kind,
		pluginId,
		label: kind,
		intervalMinutes: 360,
		timeoutMs: options.timeoutMs ?? 30_000,
		requiredEnvVars: [],
		requiredCapability: 'scheduler:cron',
	});
	registry.modules.push({ kind, pluginId, module: { run } });
}

function outcomeCalls(calls: readonly { name: string; args: unknown }[]) {
	return calls
		.filter((call) => call.name.endsWith(':recordOutcome'))
		.map((call) => {
			const args = call.args as { outcome: string; reasonCode?: string };
			return args.reasonCode === undefined
				? { outcome: args.outcome }
				: { outcome: args.outcome, reasonCode: args.reasonCode };
		});
}

describe('hosted plugin cron runtime', () => {
	beforeEach(() => {
		registry.catalog.length = 0;
		registry.modules.length = 0;
		registry.llm.generate.mockReset();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('runs an authorized cron exactly once and records a completed outcome', async () => {
		const run = vi.fn(async () => undefined);
		addCron('plugin.seed-lab.refresh', run);
		const { ctx, calls } = fixture({ authorized: true });

		await expect(
			handler(ctx, { pluginId: 'seed-lab', cronKind: 'plugin.seed-lab.refresh' })
		).resolves.toBeUndefined();

		expect(run).toHaveBeenCalledTimes(1);
		expect(outcomeCalls(calls)).toEqual([{ outcome: 'completed' }]);
	});

	it('gives the handler cancellation, a logger, and budgeted LLM but no raw context', async () => {
		let received: PluginCronServices | undefined;
		addCron('plugin.seed-lab.refresh', async (services) => {
			received = services;
		});
		const { ctx } = fixture({ authorized: true });

		await handler(ctx, { pluginId: 'seed-lab', cronKind: 'plugin.seed-lab.refresh' });

		expect(received).toBeDefined();
		expect(received!.signal).toBeInstanceOf(AbortSignal);
		expect(typeof received!.logger.info).toBe('function');
		expect(received!.llm).toBe(registry.llm);
		expect(received).not.toHaveProperty('db');
		// the lease is revoked once the tick ends
		expect(received!.signal.aborted).toBe(true);
	});

	it('no-ops without running or auditing when authorization denies (disabled plugin)', async () => {
		const run = vi.fn(async () => undefined);
		addCron('plugin.seed-lab.refresh', run);
		const { ctx, calls } = fixture({ authorized: false });

		await expect(
			handler(ctx, { pluginId: 'seed-lab', cronKind: 'plugin.seed-lab.refresh' })
		).resolves.toBeUndefined();

		expect(run).not.toHaveBeenCalled();
		expect(outcomeCalls(calls)).toEqual([]);
	});

	it('no-ops for an uninstalled cron kind absent from the catalog', async () => {
		const { ctx, calls } = fixture({ authorized: true });

		await expect(
			handler(ctx, { pluginId: 'seed-lab', cronKind: 'plugin.seed-lab.removed' })
		).resolves.toBeUndefined();

		// never even attempts to authorize an unknown kind
		expect(ctx.runMutation).not.toHaveBeenCalled();
	});

	it('no-ops for a mismatched pluginId/kind pair', async () => {
		addCron(
			'plugin.seed-lab.refresh',
			vi.fn(async () => undefined)
		);
		const { ctx } = fixture({ authorized: true });

		await handler(ctx, { pluginId: 'attacker', cronKind: 'plugin.seed-lab.refresh' });
		expect(ctx.runMutation).not.toHaveBeenCalled();
	});

	it('no-ops safely when a kind has duplicate module registrations', async () => {
		addCron(
			'plugin.seed-lab.refresh',
			vi.fn(async () => undefined)
		);
		// second registration for the same kind — ambiguous, must not execute
		registry.modules.push({
			kind: 'plugin.seed-lab.refresh',
			pluginId: 'seed-lab',
			module: { run: vi.fn(async () => undefined) },
		});
		const { ctx } = fixture({ authorized: true });

		await handler(ctx, { pluginId: 'seed-lab', cronKind: 'plugin.seed-lab.refresh' });
		expect(ctx.runMutation).not.toHaveBeenCalled();
	});

	it('records cron_invalid for a module without a callable run', async () => {
		registry.catalog.push({
			kind: 'plugin.seed-lab.refresh',
			pluginId: 'seed-lab',
			label: 'Refresh',
			intervalMinutes: 360,
			timeoutMs: 30_000,
			requiredEnvVars: [],
			requiredCapability: 'scheduler:cron',
		});
		registry.modules.push({
			kind: 'plugin.seed-lab.refresh',
			pluginId: 'seed-lab',
			module: { run: 'not-a-function' },
		});
		const { ctx, calls } = fixture({ authorized: true });

		await expect(
			handler(ctx, { pluginId: 'seed-lab', cronKind: 'plugin.seed-lab.refresh' })
		).resolves.toBeUndefined();
		expect(outcomeCalls(calls)).toEqual([{ outcome: 'failed', reasonCode: 'cron_invalid' }]);
	});

	it('records cron_failed when the handler throws and never rethrows', async () => {
		addCron('plugin.seed-lab.refresh', async () => {
			throw new Error('boom');
		});
		const { ctx, calls } = fixture({ authorized: true });

		await expect(
			handler(ctx, { pluginId: 'seed-lab', cronKind: 'plugin.seed-lab.refresh' })
		).resolves.toBeUndefined();
		expect(outcomeCalls(calls)).toEqual([{ outcome: 'failed', reasonCode: 'cron_failed' }]);
	});

	it('fails closed without running the handler when authorization errors', async () => {
		const run = vi.fn(async () => undefined);
		addCron('plugin.seed-lab.refresh', run);
		const { ctx, calls } = fixture({ authorizeThrows: true });

		await expect(
			handler(ctx, { pluginId: 'seed-lab', cronKind: 'plugin.seed-lab.refresh' })
		).resolves.toBeUndefined();
		expect(run).not.toHaveBeenCalled();
		expect(outcomeCalls(calls)).toEqual([]);
	});

	it('never rethrows even when the outcome audit mutation fails (no error loop)', async () => {
		addCron('plugin.seed-lab.refresh', async () => {
			throw new Error('boom');
		});
		const { ctx } = fixture({ authorized: true, auditThrows: true });

		await expect(
			handler(ctx, { pluginId: 'seed-lab', cronKind: 'plugin.seed-lab.refresh' })
		).resolves.toBeUndefined();
	});

	it('records cron_timeout and aborts the handler when it exceeds its wall-clock limit', async () => {
		vi.useFakeTimers();
		let observed: AbortSignal | undefined;
		addCron(
			'plugin.seed-lab.slow',
			(services) => {
				observed = services.signal;
				return new Promise<void>(() => {
					/* never resolves */
				});
			},
			{ timeoutMs: 1_000 }
		);
		const { ctx, calls } = fixture({ authorized: true });

		const settled = handler(ctx, { pluginId: 'seed-lab', cronKind: 'plugin.seed-lab.slow' });
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(settled).resolves.toBeUndefined();

		expect(observed?.aborted).toBe(true);
		expect(outcomeCalls(calls)).toEqual([{ outcome: 'failed', reasonCode: 'cron_timeout' }]);
	});
});
