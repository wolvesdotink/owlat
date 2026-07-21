import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Editor-boundary gating for adding a plugin automation step. `addStep` must
 * refuse a plugin step kind whose owning plugin is disabled or whose
 * `automation:step` capability is ungranted (both surface as a thrown
 * `PluginAuthorizationError` from `requireAuthenticatedBundledPlugin`), and must
 * never persist the row when it does — the "permission denial" / "feature-off"
 * behavior the card requires at the editor boundary. Core kinds and an
 * authorized plugin kind pass through to the insert unchanged.
 */

const requireAuth = vi.hoisted(() => vi.fn(async () => undefined));
const requireDraft = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../steps/catalog', async () => {
	const { v } = await vi.importActual<typeof import('convex/values')>('convex/values');
	return {
		isCoreStepKind: (kind: string) => !kind.startsWith('plugin.'),
		isPluginStepKind: (kind: string) => kind.startsWith('plugin.'),
		stepPluginId: () => 'deliverability',
		stepKindValidator: v.string(),
	};
});

vi.mock('../guards', () => ({ requireDraftAutomation: requireDraft }));
vi.mock('../../plugins/authorization', () => ({
	requireAuthenticatedBundledPlugin: requireAuth,
}));
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../../lib/sessionOrganization')>(
		'../../lib/sessionOrganization'
	);
	return { ...actual, getMutationContext: vi.fn(async () => ({ userId: 'u', role: 'owner' })) };
});

import { addStep } from '../steps';

const handler = (
	addStep as unknown as {
		_handler: (
			ctx: unknown,
			args: {
				automationId: string;
				stepType: string;
				config: unknown;
				insertAtIndex?: number;
			}
		) => Promise<string>;
	}
)._handler;

function makeCtx() {
	const insert = vi.fn(async () => 'step-1');
	const patch = vi.fn(async () => undefined);
	const ctx = {
		db: {
			query: () => ({ withIndex: () => ({ collect: async () => [] }) }),
			insert,
			patch,
		},
	};
	return { ctx, insert, patch };
}

beforeEach(() => {
	requireAuth.mockReset().mockResolvedValue(undefined);
	requireDraft.mockReset().mockResolvedValue(undefined);
});

describe('addStep plugin-kind gating', () => {
	it('fails closed and never persists a plugin step when authorization is denied', async () => {
		requireAuth.mockRejectedValue(new Error('Plugin access denied'));
		const { ctx, insert } = makeCtx();
		await expect(
			handler(ctx, {
				automationId: 'automation-1',
				stepType: 'plugin.deliverability.notify',
				config: { pluginConfig: {} },
			})
		).rejects.toThrow('Plugin access denied');
		expect(requireAuth).toHaveBeenCalledOnce();
		expect(insert).not.toHaveBeenCalled();
	});

	it('persists an authorized plugin step', async () => {
		const { ctx, insert } = makeCtx();
		await expect(
			handler(ctx, {
				automationId: 'automation-1',
				stepType: 'plugin.deliverability.notify',
				config: { pluginConfig: {} },
			})
		).resolves.toBe('step-1');
		expect(requireAuth).toHaveBeenCalledOnce();
		expect(insert).toHaveBeenCalledWith(
			'automationSteps',
			expect.objectContaining({ stepType: 'plugin.deliverability.notify' })
		);
	});

	it('never consults plugin authorization for a core step kind', async () => {
		const { ctx, insert } = makeCtx();
		await expect(
			handler(ctx, {
				automationId: 'automation-1',
				stepType: 'delay',
				config: { duration: 1, unit: 'hours' },
			})
		).resolves.toBe('step-1');
		expect(requireAuth).not.toHaveBeenCalled();
		expect(insert).toHaveBeenCalledOnce();
	});
});
