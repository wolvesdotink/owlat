import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for the `firePluginTrigger` host seam — the security-gated entry
 * point a bundled plugin's own code (a future webhook-event source) calls to fan
 * a contact into automations subscribed to its namespaced trigger kind.
 *
 * Every denial cause (uncatalogued kind, mismatched plugin attribution, denied
 * authorization, unregistered module) must fan out nothing without ever touching
 * the plugin module; the single allow path must round-trip the persisted
 * `pluginConfig` into the module's `parseConfig`, clamp the untrusted trigger
 * data, and create a run through the shared fanout (running-instance guard,
 * no-steps guard, `triggerData` persist).
 */

const catalogEntry = vi.hoisted(() =>
	vi.fn((_kind: string): { pluginId: string } | undefined => ({ pluginId: 'crm-sync' }))
);
const authorize = vi.hoisted(() =>
	vi.fn(async (): Promise<{ pluginId: string } | null> => ({ pluginId: 'crm-sync' }))
);
const moduleFor = vi.hoisted(() => vi.fn((_kind: string): unknown => undefined));
const bumpStats = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../triggers/catalog', () => ({
	isCoreTriggerKind: () => false,
	pluginTriggerCatalogEntry: catalogEntry,
}));
vi.mock('../triggers/pluginTriggers', () => ({ pluginTriggerModuleFor: moduleFor }));
vi.mock('../../plugins/authorization', () => ({ authorizeSystemBundledPlugin: authorize }));
vi.mock('../statShards', () => ({ bumpAutomationStats: bumpStats }));

import { firePluginTrigger } from '../triggers';

const handler = (
	firePluginTrigger as unknown as {
		_handler: (
			ctx: unknown,
			args: { pluginId: string; localId: string; contactId: string; payload?: unknown }
		) => Promise<{ triggered: number }>;
	}
)._handler;

interface FanoutState {
	readonly automations?: readonly Record<string, unknown>[];
	readonly existingRun?: unknown;
	readonly firstStep?: unknown;
}

function makeCtx(state: FanoutState = {}) {
	const inserted: { table: string; doc: Record<string, unknown> }[] = [];
	const runAfter = vi.fn(async () => undefined);
	const ctx = {
		db: {
			query: (table: string) => {
				const builder = {
					withIndex: () => builder,
					filter: () => builder,
					collect: async () => (table === 'automations' ? (state.automations ?? []) : []),
					first: async () =>
						table === 'automationRuns'
							? (state.existingRun ?? null)
							: table === 'automationSteps'
								? (state.firstStep ?? null)
								: null,
				};
				return builder;
			},
			insert: async (table: string, doc: Record<string, unknown>) => {
				inserted.push({ table, doc });
				return `run-${inserted.length}`;
			},
			patch: async () => undefined,
		},
		scheduler: { runAfter },
	};
	return { ctx, inserted, runAfter };
}

const args = {
	pluginId: 'crm-sync',
	localId: 'deal-won',
	contactId: 'contact-1',
	payload: { amount: 500 },
};

/** True when `text` carries a C0 control character or DEL. */
function hasControlCharacter(text: string): boolean {
	for (const character of text) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 0x20 || codePoint === 0x7f) return true;
	}
	return false;
}

beforeEach(() => {
	catalogEntry.mockReset().mockReturnValue({ pluginId: 'crm-sync' });
	authorize.mockReset().mockResolvedValue({ pluginId: 'crm-sync' });
	moduleFor.mockReset().mockReturnValue(undefined);
	bumpStats.mockReset().mockResolvedValue(undefined);
});

describe('firePluginTrigger', () => {
	it('fans out nothing for an uncatalogued kind and never authorizes', async () => {
		catalogEntry.mockReturnValue(undefined);
		const { ctx } = makeCtx();
		await expect(handler(ctx, args)).resolves.toEqual({ triggered: 0 });
		expect(authorize).not.toHaveBeenCalled();
		expect(moduleFor).not.toHaveBeenCalled();
	});

	it('fans out nothing when the catalogued kind is owned by another plugin', async () => {
		catalogEntry.mockReturnValue({ pluginId: 'other-pack' });
		const { ctx } = makeCtx();
		await expect(handler(ctx, args)).resolves.toEqual({ triggered: 0 });
		expect(authorize).not.toHaveBeenCalled();
	});

	it('fans out nothing when authorization is denied and never loads the module', async () => {
		authorize.mockResolvedValue(null);
		const { ctx } = makeCtx();
		await expect(handler(ctx, args)).resolves.toEqual({ triggered: 0 });
		expect(authorize).toHaveBeenCalledOnce();
		expect(moduleFor).not.toHaveBeenCalled();
	});

	it('fans out nothing when the module is not registered', async () => {
		moduleFor.mockReturnValue(undefined);
		const { ctx } = makeCtx();
		await expect(handler(ctx, args)).resolves.toEqual({ triggered: 0 });
		expect(moduleFor).toHaveBeenCalledOnce();
	});

	it('round-trips pluginConfig into parseConfig and starts a run on the allow path', async () => {
		const parseConfig = vi.fn((raw: unknown) => raw);
		const matches = vi.fn(() => true);
		const buildTriggerData = vi.fn(() => ({ score: 9 }));
		moduleFor.mockReturnValue({ parseConfig, matches, buildTriggerData });

		const { ctx, inserted, runAfter } = makeCtx({
			automations: [{ _id: 'automation-1', triggerConfig: { pluginConfig: { threshold: 5 } } }],
			existingRun: null,
			firstStep: { _id: 'step-1' },
		});

		await expect(handler(ctx, args)).resolves.toEqual({ triggered: 1 });

		// The persisted `{ pluginConfig }` arm is unwrapped before it reaches the module.
		expect(parseConfig).toHaveBeenCalledWith({ threshold: 5 });
		expect(matches).toHaveBeenCalledWith(
			{ contactId: 'contact-1', payload: { amount: 500 } },
			{ threshold: 5 }
		);
		expect(inserted).toHaveLength(1);
		expect(inserted[0]!.table).toBe('automationRuns');
		expect(inserted[0]!.doc).toMatchObject({
			automationId: 'automation-1',
			contactId: 'contact-1',
			status: 'running',
			triggeredBy: 'plugin.crm-sync.deal-won',
			triggerData: { score: 9 },
		});
		expect(bumpStats).toHaveBeenCalledOnce();
		expect(runAfter).toHaveBeenCalledOnce();
	});

	it('clamps oversized and control-laden trigger data before persisting', async () => {
		const longKey = 'k'.repeat(500);
		const controlValue = ['boom', 'injected', 'x'.repeat(4000)].join(String.fromCodePoint(0));
		const oversized: Record<string, string | number | boolean | null> = { count: 3 };
		for (let index = 0; index < 100; index += 1) oversized[`key_${index}`] = `value_${index}`;
		oversized[longKey] = controlValue;

		moduleFor.mockReturnValue({
			parseConfig: (raw: unknown) => raw,
			matches: () => true,
			buildTriggerData: () => oversized,
		});
		const { ctx, inserted } = makeCtx({
			automations: [{ _id: 'automation-1', triggerConfig: { pluginConfig: {} } }],
			existingRun: null,
			firstStep: { _id: 'step-1' },
		});

		await expect(handler(ctx, args)).resolves.toEqual({ triggered: 1 });
		const persisted = inserted[0]!.doc['triggerData'] as Record<string, unknown>;

		// Key count is bounded.
		expect(Object.keys(persisted).length).toBeLessThanOrEqual(32);
		// Non-string primitives survive untouched.
		expect(persisted['count']).toBe(3);
		// Every persisted key is length-bounded and free of control characters; every
		// persisted string value is length-bounded and control characters are stripped.
		for (const [key, value] of Object.entries(persisted)) {
			expect([...key].length).toBeLessThanOrEqual(128);
			expect(hasControlCharacter(key)).toBe(false);
			if (typeof value === 'string') {
				expect([...value].length).toBeLessThanOrEqual(1024);
				expect(hasControlCharacter(value)).toBe(false);
			}
		}
	});

	it('honours the running-instance guard without inserting a run', async () => {
		moduleFor.mockReturnValue({ parseConfig: (raw: unknown) => raw, matches: () => true });
		const { ctx, inserted } = makeCtx({
			automations: [{ _id: 'automation-1', triggerConfig: { pluginConfig: {} } }],
			existingRun: { _id: 'run-existing' },
			firstStep: { _id: 'step-1' },
		});
		await expect(handler(ctx, args)).resolves.toEqual({ triggered: 0 });
		expect(inserted).toHaveLength(0);
	});

	it('honours the no-steps guard without inserting a run', async () => {
		moduleFor.mockReturnValue({ parseConfig: (raw: unknown) => raw, matches: () => true });
		const { ctx, inserted } = makeCtx({
			automations: [{ _id: 'automation-1', triggerConfig: { pluginConfig: {} } }],
			existingRun: null,
			firstStep: null,
		});
		await expect(handler(ctx, args)).resolves.toEqual({ triggered: 0 });
		expect(inserted).toHaveLength(0);
	});
});
