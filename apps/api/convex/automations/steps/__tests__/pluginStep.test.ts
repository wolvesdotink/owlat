import { beforeEach, describe, expect, it, vi } from 'vitest';

const stepExecute = vi.fn();
const parseConfig = vi.fn((raw: unknown) => raw);

vi.mock('../../../plugins/automationStepCatalog.generated', () => ({
	BUNDLED_PLUGIN_AUTOMATION_STEP_CATALOG: [
		{
			kind: 'plugin.deliverability.notify',
			pluginId: 'deliverability',
			localId: 'notify',
			label: 'Notify',
			description: 'Send a notification',
			icon: 'bell',
			requiredEnvVars: [],
			requiredCapability: 'automation:step',
		},
	],
}));

vi.mock('../../../plugins/automationStepModules.generated', () => ({
	BUNDLED_PLUGIN_AUTOMATION_STEP_MODULES: [
		{
			kind: 'plugin.deliverability.notify',
			pluginId: 'deliverability',
			module: Object.freeze({ parseConfig, execute: stepExecute }),
		},
	],
}));

vi.mock('../../../plugins/authorization', () => ({
	getBundledPluginManifest: () => ({
		id: 'deliverability',
		version: '1.0.0',
		capabilities: ['automation:step'],
		flag: { default: false },
	}),
}));

vi.mock('../../../lib/env', () => ({ isEnvPresent: () => true }));

const { executePluginStep } = await import('../pluginStep');

interface FakeCtx {
	readonly runMutation: ReturnType<typeof vi.fn>;
}

function makeCtx(authorized: boolean): FakeCtx {
	return {
		runMutation: vi.fn(async (_ref: unknown, args: Record<string, unknown>) =>
			'outcome' in args ? undefined : authorized
		),
	};
}

const step = {
	stepType: 'plugin.deliverability.notify',
	config: { pluginConfig: { channel: 'ops' } },
} as never;

const contact = { email: 'vip@example.test', hasOpened: true } as never;

beforeEach(() => {
	stepExecute.mockReset();
	parseConfig.mockClear();
});

describe('hosted plugin automation step execution', () => {
	it('completes when the plugin is authorized and the module completes', async () => {
		stepExecute.mockResolvedValue({ kind: 'completed' });
		const ctx = makeCtx(true);
		const outcome = await executePluginStep(ctx as never, step, contact);
		expect(outcome).toEqual({ status: 'completed' });
		expect(stepExecute).toHaveBeenCalledOnce();
		// The bounded input carries the email and engagement flags, never the raw row.
		const [input, config] = stepExecute.mock.calls[0]!;
		expect(input).toMatchObject({ contactEmail: 'vip@example.test' });
		expect(
			(input as { contactProperties: Record<string, unknown> }).contactProperties['hasOpened']
		).toBe(true);
		expect(config).toEqual({ channel: 'ops' });
	});

	it('fails closed when authorization is denied and never runs the module', async () => {
		const ctx = makeCtx(false);
		const outcome = await executePluginStep(ctx as never, step, contact);
		expect(outcome).toEqual({ status: 'failed', error: 'Plugin automation step access denied' });
		expect(stepExecute).not.toHaveBeenCalled();
	});

	it('maps a plugin-reported failure to a failed outcome with a scrubbed reason', async () => {
		stepExecute.mockResolvedValue({ kind: 'failed', reason: 'boom\u0000injected' });
		const ctx = makeCtx(true);
		const outcome = await executePluginStep(ctx as never, step, contact);
		expect(outcome.status).toBe('failed');
		// The NUL control character in the untrusted reason is replaced with a space.
		expect((outcome as { error: string }).error).toBe('boom injected');
	});

	it('fails when the module returns a malformed result', async () => {
		stepExecute.mockResolvedValue({ kind: 'sideways' });
		const ctx = makeCtx(true);
		const outcome = await executePluginStep(ctx as never, step, contact);
		expect(outcome).toEqual({ status: 'failed', error: 'Plugin automation step failed' });
	});

	it('fails when the module throws', async () => {
		stepExecute.mockRejectedValue(new Error('explode'));
		const ctx = makeCtx(true);
		const outcome = await executePluginStep(ctx as never, step, contact);
		expect(outcome).toEqual({ status: 'failed', error: 'Plugin automation step failed' });
	});

	it('still completes the step and logs once when the audit write fails', async () => {
		stepExecute.mockResolvedValue({ kind: 'completed' });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const ctx = {
			runMutation: vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
				if ('outcome' in args) throw new Error('audit down');
				return true; // authorized
			}),
		};
		const outcome = await executePluginStep(ctx as never, step, contact);
		expect(outcome).toEqual({ status: 'completed' });
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});

	it('fails a never-resolving module within the host deadline', async () => {
		vi.useFakeTimers();
		try {
			stepExecute.mockImplementation(() => new Promise(() => undefined)); // never resolves
			const ctx = makeCtx(true);
			const pending = executePluginStep(ctx as never, step, contact);
			await vi.advanceTimersByTimeAsync(30_000);
			await expect(pending).resolves.toEqual({
				status: 'failed',
				error: 'Plugin automation step failed',
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('fails for an unknown plugin step kind without touching the module', async () => {
		const ctx = makeCtx(true);
		const outcome = await executePluginStep(
			ctx as never,
			{ stepType: 'plugin.deliverability.ghost', config: {} } as never,
			contact
		);
		expect(outcome.status).toBe('failed');
		expect(stepExecute).not.toHaveBeenCalled();
	});
});
