import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api } from '../_generated/api';
import { enableFeatures } from './factories';
import { runLlmStream } from '../lib/llm/dispatch';
import type * as SessionOrganization from '../lib/sessionOrganization';
import type * as LlmProvider from '../lib/llmProvider';
import type * as Dispatch from '../lib/llm/dispatch';

/**
 * Whole-draft Revise (mail/ai/reviseDraft.reviseDraft) and tool-call markup a
 * model typed into a draft (#1254): a draft saved before the fix loses a
 * leading markup prefix before the model sees it and is refused when markup
 * sits elsewhere; a revision is shown and stored without a markup prefix, and
 * settles `error` when markup sits inside it. The model is mocked; convex-test
 * drives the real buffer.
 */

const modules = import.meta.glob('../**/*.*s');
const sess = vi.hoisted(() => ({ user: { userId: 'user-a', role: 'owner' as const } }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganization>('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => sess.user),
		isActiveOrgMember: vi.fn(async () => true),
		getUserIdFromSession: vi.fn(async () => sess.user.userId),
		getMutationContext: vi.fn(async () => sess.user),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sess.user.userId,
			activeOrganizationId: 'org-a',
			role: sess.user.role,
		})),
		// The D7 apply path persists through `inbox.mutations.editDraft`
		// (adminMutation), whose floor resolves via requireAdminContext.
		requireAdminContext: vi.fn(async () => sess.user),
	};
});

vi.mock('../lib/llmProvider', async () => {
	const actual = await vi.importActual<typeof LlmProvider>('../lib/llmProvider');
	return {
		...actual,
		resolveLanguageModel: vi.fn(() => 'test-model'),
		resolveLanguageModelForUserText: vi.fn(() => 'test-model'),
	};
});

vi.mock('../lib/llm/dispatch', async () => {
	const actual = await vi.importActual<typeof Dispatch>('../lib/llm/dispatch');
	return { ...actual, runLlmStream: vi.fn() };
});

async function makeT() {
	const t = convexTest(schema, modules);
	await enableFeatures(t, ['mail.external']);
	rateLimiterTest.register(t);
	return t;
}

beforeEach(() => {
	sess.user = { userId: 'user-a', role: 'owner' };
	vi.mocked(runLlmStream).mockReset();
});

const MARKUP =
	'<invoke name="recallKnowledge">\n' +
	'<parameter name="query">availability 14-16 December 2026 for 2 guests</parameter>\n' +
	'</invoke>\n\n' +
	'<function_results>\n{"results":[]}\n</function_results>';
const REPLY = 'Hi John,\n\nThe room is yours.\n\nBest,\nAda';

function revisesTo(text: string) {
	vi.mocked(runLlmStream).mockImplementation(async (opts) => {
		await opts.onTextDelta?.(text, text);
		return {
			text,
			tokenUsage: undefined,
			modelUsed: 'test-model',
			finishReason: 'stop',
			aborted: false,
		};
	});
}

async function revise(t: Awaited<ReturnType<typeof makeT>>, currentDraft: string) {
	const streamId = await t.mutation(api.mail.draftStreamStore.createDraftStream, {
		surface: 'compose',
	});
	const res = await t.action(api.mail.ai.reviseDraft.reviseDraft, {
		streamId,
		instruction: 'Make it shorter.',
		currentDraft,
		surface: 'compose',
	});
	const buffer = await t.query(api.mail.draftStreamStore.getDraftStream, { streamId });
	return { res, buffer };
}

describe('reviseDraft — leaked tool-call markup', () => {
	it('revises a draft without the markup prefix it was saved with', async () => {
		const t = await makeT();
		await enableFeatures(t, ['ai']);
		revisesTo(REPLY);
		const { res } = await revise(t, MARKUP + REPLY);
		expect(res).toMatchObject({ status: 'complete', text: REPLY });
		const prompt = JSON.stringify(vi.mocked(runLlmStream).mock.calls[0]![0].messages);
		expect(prompt).toContain('The room is yours.');
		expect(prompt).not.toContain('<invoke');
	});

	it('refuses a draft with markup inside it, without a model call', async () => {
		const t = await makeT();
		await enableFeatures(t, ['ai']);
		const { res, buffer } = await revise(t, `Hi John,\n\n${MARKUP}\nBest`);
		expect(res).toEqual({ text: '', injectionFlagged: false, status: 'error' });
		expect(buffer).toMatchObject({ status: 'error', text: '' });
		expect(runLlmStream).not.toHaveBeenCalled();
	});

	it('streams and stores a revision without the markup prefix the model wrote', async () => {
		const t = await makeT();
		await enableFeatures(t, ['ai']);
		const shown: Array<string | undefined> = [];
		vi.mocked(runLlmStream).mockImplementation(async (opts) => {
			// The first delta is always written out: it is still inside the prefix.
			await opts.onTextDelta?.(
				'<invoke name="recallKnowledge">',
				'<invoke name="recallKnowledge">'
			);
			const streams = await t.run(async (ctx) => ctx.db.query('aiDraftStreams').collect());
			shown.push(streams[0]?.text);
			return {
				text: MARKUP + REPLY,
				tokenUsage: undefined,
				modelUsed: 'test-model',
				finishReason: 'stop',
				aborted: false,
			};
		});
		const { res, buffer } = await revise(t, 'Sure, happy to help.');
		expect(shown).toEqual(['']);
		expect(res).toMatchObject({ status: 'complete', text: REPLY });
		expect(buffer).toMatchObject({ status: 'complete', text: REPLY });
	});

	it('settles error, storing nothing, when the revision has markup inside it', async () => {
		const t = await makeT();
		await enableFeatures(t, ['ai']);
		revisesTo(`Hi John,\n\n${MARKUP}\nBest`);
		const { res, buffer } = await revise(t, 'Sure, happy to help.');
		expect(res).toEqual({ text: '', injectionFlagged: false, status: 'error' });
		expect(buffer).toMatchObject({ status: 'error', text: '' });
	});
});
