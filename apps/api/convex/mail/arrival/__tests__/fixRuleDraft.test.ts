/**
 * Fix with a reason: the reason compiles, after the Fix,
 * through rules' compile path into the draft the Fix wrote, `ready` with a
 * preview the person still has to confirm (no filter is created), or
 * `failed` when AI is off. The `compileFixRuleDraft` hook is no longer a stub.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../_generated/api';
import { enableFeatures } from '../../../__tests__/factories';
import type { CompiledFilter } from '../../filterCompile';
import { seedUserFolder } from '../../rules/__tests__/rules.testlib';
import { ARRIVAL_HOOK_STUBS } from '../hooks';
import { deliverLive, learnTest, seedPersonalMailbox, type T } from './learn.testlib';

const llm = vi.hoisted(() => ({ runLlmObject: vi.fn() }));

vi.mock('../../../lib/llm/dispatch', async () => {
	const { metered } = await import('../../../analytics/__tests__/meteredDispatch.testlib');
	return { runLlmObject: metered((opts: unknown) => llm.runLlmObject(opts)) };
});
vi.mock('../../../lib/llmProvider', () => ({
	resolveLanguageModel: vi.fn(async () => ({ modelId: 'stub-model' })),
}));
vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner' as const, activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

const DELAYS: CompiledFilter = {
	name: 'Train delays',
	matchType: 'all',
	conditions: [{ field: 'from', op: 'contains', value: 'shop.example' }],
	aiQuestion: 'Is this about a delay on a trip I am booked on?',
	actions: [{ type: 'placeInNeedsMe' }, { type: 'moveToFolder', folder: 'Travel' }],
};

beforeEach(() => {
	llm.runLlmObject.mockReset();
	llm.runLlmObject.mockImplementation(async () => ({
		object: DELAYS,
		tokenUsage: undefined,
		modelUsed: 'stub-model',
	}));
});

afterEach(() => {
	vi.useRealTimers();
});

async function fixWithReason(t: T) {
	const { message } = await deliverLive(t);
	const result = await t.mutation(api.mail.arrival.fix.apply, {
		messageId: message._id,
		destination: 'needs_me',
		scope: 'sender',
		reason: 'Delays on trips I am booked on matter to me',
	});
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	return { message, result };
}

describe('a Fix reason compiles into a draft rule', () => {
	it('is no longer a stub', () => {
		expect(ARRIVAL_HOOK_STUBS.size).toBe(0);
	});

	it('lands the Fix draft ready with a preview, and saves no filter', async () => {
		vi.useFakeTimers();
		const t = learnTest();
		const { mailboxId } = await seedPersonalMailbox(t);
		await enableFeatures(t, ['ai', 'postbox']);
		const travel = await seedUserFolder(t, mailboxId, 'Travel');
		const { message, result } = await fixWithReason(t);

		// One compile call over the reason (the arrival read makes its own calls).
		const compiles = llm.runLlmObject.mock.calls.filter(([opts]) =>
			String((opts as { prompt?: string }).prompt).includes('Delays on trips I am booked on')
		);
		expect(compiles).toHaveLength(1);
		const { drafts, filters } = await t.run(async (ctx) => ({
			drafts: await ctx.db.query('mailRuleDrafts').collect(),
			filters: await ctx.db.query('mailFilters').collect(),
		}));
		expect(drafts).toHaveLength(1);
		expect(drafts[0]!._id).toBe(result.ruleDraftId);
		expect(drafts[0]).toMatchObject({ status: 'ready', origin: 'fix', fromMessageId: message._id });
		expect(drafts[0]!.preview).toMatchObject({
			name: 'Train delays',
			aiCondition: { question: 'Is this about a delay on a trip I am booked on?' },
			actions: [{ type: 'placeInNeedsMe' }, { type: 'moveToFolder', folderId: travel }],
		});
		expect(filters).toEqual([]);
	});

	it('fails the draft when AI is off, without a model call', async () => {
		vi.useFakeTimers();
		const t = learnTest();
		await seedPersonalMailbox(t);
		await fixWithReason(t);
		expect(llm.runLlmObject).not.toHaveBeenCalled();
		const drafts = await t.run(async (ctx) => ctx.db.query('mailRuleDrafts').collect());
		expect(drafts.map((d) => d.status)).toEqual(['failed']);
	});
});
