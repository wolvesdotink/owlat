/**
 * The Team draft step's writer route (./writerRoute.ts). With the routing
 * policy's `cheapFirstWriter` off (the default) the step is today's: one
 * writer on today's tier, no shadow-mode read, no cheap-first mark. Switched
 * to `reviewed`, only a draft no auto-send can follow (shadow mode on) of an
 * eligible message goes cheap-first, and that draft is marked for review
 * only, so the `cheap_first_draft` gate refuses to send it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStepCtx, writesOf } from '../../__tests__/stepCtx';
import type { SharedDraftParams } from '../../../shared/draftService';

const mocks = vi.hoisted(() => ({
	shared: [] as SharedDraftParams[],
	resolved: [] as unknown[],
}));

vi.mock('../../../../lib/llmProvider', async (importActual) => ({
	...(await importActual<object>()),
	resolveLanguageModel: vi.fn(async (_ctx: unknown, task: string, choice?: { tier?: string }) => {
		mocks.resolved.push([task, choice?.tier]);
		return `model:${choice?.tier}`;
	}),
}));
vi.mock('../../../shared/draftService', async (importActual) => ({
	...(await importActual<object>()),
	runSharedDraft: vi.fn(async (_ctx: unknown, params: SharedDraftParams) => {
		mocks.shared.push(params);
		return {
			draftBody: 'Thanks, noted.',
			draftQuality: { score: 0.9, complete: true, grounded: true, flags: [] },
			planCoverage: null,
			tokenUsage: undefined,
			modelUsed: 'm',
		};
	}),
}));

import { draftStep, type DraftInput } from '../index';
import { draftWriterRoute } from '../writerRoute';
import type { Id } from '../../../../_generated/dataModel';

const input: DraftInput = {
	inboundMessageId: 'msg_1' as Id<'inboundMessages'>,
	context: 'Sam: FYI, the invoice arrived.',
	classification: {
		category: 'general',
		priority: 'low',
		sentiment: 'positive',
		intent: 'information',
		confidence: 0.95,
	},
};

function stepCtx(routes: { policy?: unknown; shadow?: unknown }) {
	const queried: string[] = [];
	const ctx = makeStepCtx<Parameters<typeof draftStep.execute>[0]>({
		queries: {
			getAgentConfig: null,
			getMessage: { subject: 'Invoice' },
			getResolved: () => {
				queried.push('policy');
				if (routes.policy instanceof Error) throw routes.policy;
				return routes.policy;
			},
			getShadowMode: () => {
				queried.push('shadow');
				if (routes.shadow instanceof Error) throw routes.shadow;
				return routes.shadow;
			},
			evaluateForMessage: { stances: [] },
			loadPlanInput: null,
		},
		actions: { suggestAttachments: null },
	});
	return { ctx, queried };
}

beforeEach(() => {
	mocks.shared = [];
	mocks.resolved = [];
});

describe('draftWriterRoute', () => {
	const signals = { category: 'general', intent: 'information', priority: 'low', confidence: 0.95 };
	const route = (routes: { policy?: unknown; shadow?: unknown }) =>
		draftWriterRoute(stepCtx(routes).ctx, signals);

	it('is today’s route with the switch off, and never reads shadow mode then', async () => {
		const off = stepCtx({ policy: { cheapFirstWriter: 'off' }, shadow: { enabled: true } });
		expect(await draftWriterRoute(off.ctx, signals)).toBe('capable');
		expect(off.queried).toEqual(['policy']);
		expect(await route({ policy: new Error('unreadable') })).toBe('capable');
		expect(await route({ policy: undefined })).toBe('capable');
	});

	it('goes cheap-first only for a reviewed draft: shadow mode known to be on', async () => {
		const reviewed = { cheapFirstWriter: 'reviewed' };
		expect(await route({ policy: reviewed, shadow: { enabled: true } })).toBe('cheap_first');
		expect(await route({ policy: reviewed, shadow: { enabled: false } })).toBe('capable');
		expect(await route({ policy: reviewed, shadow: new Error('unreadable') })).toBe('capable');
	});
});

describe('draftStep with the writer route', () => {
	it('switch off (default): one writer on today’s capable tier, no mark', async () => {
		const { ctx } = stepCtx({ policy: { cheapFirstWriter: 'off' } });
		const { writes } = await draftStep.execute(ctx, input);
		const recorded = writesOf(writes, 'draft_output');

		const [params] = mocks.shared;
		expect(params?.writer).toBeUndefined();
		await params!.resolveModel();
		expect(mocks.resolved).toEqual([['mail.draft', 'capable']]);
		expect(recorded[0]).not.toHaveProperty('isCheapFirstDraft');
	});

	it('switch on, shadow mode on: the fast writer first, the capable escalation, and the review-only mark', async () => {
		const { ctx } = stepCtx({
			policy: { cheapFirstWriter: 'reviewed' },
			shadow: { enabled: true },
		});
		const { writes } = await draftStep.execute(ctx, input);
		const recorded = writesOf(writes, 'draft_output');

		const [params] = mocks.shared;
		await params!.resolveModel();
		await params!.writer!.resolveCapable();
		expect(mocks.resolved).toEqual([
			['mail.draft', 'fast'],
			['mail.draft', 'capable'],
		]);
		expect(recorded[0]).toMatchObject({ isCheapFirstDraft: true });
	});

	it('switch on, shadow mode off (the draft could auto-send): today’s writer, no mark', async () => {
		const { ctx } = stepCtx({
			policy: { cheapFirstWriter: 'reviewed' },
			shadow: { enabled: false },
		});
		const { writes } = await draftStep.execute(ctx, input);
		const recorded = writesOf(writes, 'draft_output');

		expect(mocks.shared[0]?.writer).toBeUndefined();
		expect(recorded[0]).not.toHaveProperty('isCheapFirstDraft');
	});
});
