/**
 * "Draft a nudge" (SPEC §7, mail/ai/nudgeDraft.ts): `composeDraft.start` with
 * `purpose: 'nudge'` runs the ordinary Answer mode drafter on a reply to our
 * own last message, with the server's nudge instruction as trusted owner
 * input, written as a follow-up to the person we wait on, without asking
 * anything first. A fenced or muted thread, or a team inbox, offers no
 * nudge. The model and provider are mocked; convex-test runs the real
 * queries and mutations.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api } from '../_generated/api';
import { enableFeatures } from './factories';
import { runLlmObject, runLlmTextWithTools } from '../lib/llm/dispatch';
import { CUSTOMER, OWNER_ADDRESS, seedRequest } from './helpers/answerAsk';

import type * as SessionOrganizationModule from '../lib/sessionOrganization';
import type * as LlmProviderModule from '../lib/llmProvider';
import type * as TaskRoutingModule from '../lib/llm/taskRouting';
import type * as DispatchModule from '../lib/llm/dispatch';

const modules = import.meta.glob('../**/*.*s');

const DRAFT = 'Hi Jonas,\n\njust checking in on the invoice.\n\nBest,\nAda';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganizationModule>(
		'../lib/sessionOrganization'
	);
	const user = { userId: 'user-a', role: 'member' as const, activeOrganizationId: 'org-a' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => user),
		isActiveOrgMember: vi.fn(async () => true),
		getUserIdFromSession: vi.fn(async () => user.userId),
		getMutationContext: vi.fn(async () => user),
		getBetterAuthSessionWithRole: vi.fn(async () => ({ ...user })),
	};
});
vi.mock('../lib/llmProvider', async () => {
	const actual = await vi.importActual<typeof LlmProviderModule>('../lib/llmProvider');
	const { taskTier } = await vi.importActual<typeof TaskRoutingModule>('../lib/llm/taskRouting');
	return {
		...actual,
		resolveLanguageModel: vi.fn((_ctx: unknown, ...route: Parameters<typeof taskTier>) =>
			taskTier(...route)
		),
	};
});
vi.mock('../lib/llm/dispatch', async () => {
	const actual = await vi.importActual<typeof DispatchModule>('../lib/llm/dispatch');
	const result = { tokenUsage: undefined, modelUsed: 'test-model' };
	return {
		...actual,
		runLlmObject: vi.fn(async () => ({ object: { slots: [], translations: [] }, ...result })),
		runLlmText: vi.fn(async () => ({ text: 'A candidate reply.', ...result })),
		runLlmStream: vi.fn(),
		runLlmTextWithTools: vi.fn(async () => ({ text: DRAFT, ...result, finishReason: 'stop' })),
	};
});

async function makeT() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await enableFeatures(t, ['mail.external', 'ai']);
	return t;
}

type Tx = Awaited<ReturnType<typeof makeT>>;

/**
 * Jonas asked, we answered, and he has not replied: a reply draft to our own
 * answer, addressed to him as the composer addresses it.
 */
async function nudgeDraft(t: Tx, opts: { isFenced?: boolean; isMuted?: boolean } = {}) {
	const { mailboxId, messageId } = await seedRequest(t);
	const ourReply = await t.run(async (ctx) => {
		const asked = (await ctx.db.get(messageId))!;
		const sent = (await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', 'sent'))
			.first())!;
		const { _id, _creationTime, ...base } = asked;
		const id = await ctx.db.insert('mailMessages', {
			...base,
			folderId: sent._id,
			fromAddress: OWNER_ADDRESS,
			toAddresses: [CUSTOMER],
			subject: 'Re: September invoice',
			textBodyInline: 'Hi Jonas, the invoice is attached. Could you confirm the PO?',
			rfc822MessageId: '<our-reply@example.com>',
			receivedAt: asked.receivedAt + 60_000,
			internalDate: asked.receivedAt + 60_000,
		});
		if (opts.isFenced) {
			await ctx.db.patch(asked.threadId, { interpretationStaleSince: Date.now() });
		}
		if (opts.isMuted) await ctx.db.patch(asked.threadId, { mutedAt: Date.now() });
		return id;
	});
	const { draftId } = await t.mutation(api.mail.drafts.create, {
		mailboxId,
		inReplyToMessageId: ourReply,
	});
	await t.mutation(api.mail.drafts.update, { draftId, toAddresses: [CUSTOMER] });
	return { mailboxId, target: { kind: 'mailDraft' as const, draftId } };
}

function lastDraftPrompt(): string {
	const calls = vi.mocked(runLlmTextWithTools).mock.calls;
	return JSON.stringify(calls[calls.length - 1]![0].messages);
}

beforeEach(() => {
	vi.mocked(runLlmObject).mockClear();
	vi.mocked(runLlmTextWithTools).mockClear();
});

describe('start with purpose nudge', () => {
	it('drafts a follow-up through the compose path with the nudge instruction', async () => {
		const t = await makeT();
		const { target } = await nudgeDraft(t);

		const res = await t.action(api.mail.ai.composeDraft.start, {
			target,
			purpose: 'nudge',
			instruction: 'Mention the books close Friday',
			locale: 'en',
		});

		expect(res.status).toBe('ready');
		expect(res.questions).toEqual([]);
		const prompt = lastDraftPrompt();
		expect(prompt).toContain('[CONFIRMED BY OWNER]');
		expect(prompt).toContain('Write a follow-up nudge, not an answer');
		expect(prompt).toContain('Write in the language the thread is written in.');
		expect(prompt).toContain('The owner adds: Mention the books close Friday');
		expect(prompt).toContain("following up on the owner's own last message");
		// Nothing is asked first: the gap check's slot extraction never ran.
		const prompts = vi
			.mocked(runLlmObject)
			.mock.calls.map(([opts]) => String((opts as { prompt?: string }).prompt ?? ''));
		expect(prompts.some((p) => p.includes('Identify the SLOTS'))).toBe(false);
		const session = await t.query(api.mail.ai.composeDraftStore.getSession, { target });
		expect(session?.status).toBe('ready');
	});

	it('refuses a nudge on a thread whose reading is fenced off', async () => {
		const t = await makeT();
		const { target } = await nudgeDraft(t, { isFenced: true });
		await expect(
			t.action(api.mail.ai.composeDraft.start, { target, purpose: 'nudge', locale: 'en' })
		).rejects.toThrow(/No nudge/);
		expect(vi.mocked(runLlmTextWithTools)).not.toHaveBeenCalled();
	});

	it('refuses a nudge on a muted thread or in a team inbox (F6)', async () => {
		const t = await makeT();
		const muted = await nudgeDraft(t, { isMuted: true });
		await expect(
			t.action(api.mail.ai.composeDraft.start, {
				target: muted.target,
				purpose: 'nudge',
				locale: 'en',
			})
		).rejects.toThrow(/No nudge/);

		const team = await nudgeDraft(t);
		await t.run(async (ctx) => ctx.db.patch(team.mailboxId, { scope: 'shared' }));
		await expect(
			t.action(api.mail.ai.composeDraft.start, {
				target: team.target,
				purpose: 'nudge',
				locale: 'en',
			})
		).rejects.toThrow(/No nudge/);
		expect(vi.mocked(runLlmTextWithTools)).not.toHaveBeenCalled();
	});
});
