/**
 * The response plan store (responsePlan.ts, responsePlanDraft.ts,
 * responsePlanState.ts) and Answer mode's coverage check (coverage.ts) against
 * a real schema, with the model mocked: default stances, the owner's stance
 * writes under the thread's reader rule, sealed claims, staleness, the plan
 * going with its draft, and the item links of the Reply Queue questions.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import betterAuthSchema from '../../../betterAuth/schema';
import { api, internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { enableFeatures } from '../../../__tests__/factories';
import type * as LlmDispatch from '../../../lib/llm/dispatch';
import { modules, reduceItem, reduceResult, seedMailThread, type Test } from './interpret.testlib';

const session = vi.hoisted(() => ({
	current: { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' } as {
		userId: string;
		role: string;
		activeOrganizationId: string;
	} | null,
}));
const runLlmObjectMock = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session.current),
		isActiveOrgMember: vi.fn(async () => session.current !== null),
		getMutationContext: vi.fn(async () => session.current),
		getBetterAuthSessionWithRole: vi.fn(async () => session.current),
		getSingletonOrganizationId: vi.fn(async () => 'org-1'),
	};
});
vi.mock('../../../lib/llmProvider', () => ({ resolveLanguageModel: vi.fn(() => 'test-model') }));
vi.mock('../../../lib/llm/dispatch', async () => {
	const actual = await vi.importActual<typeof LlmDispatch>('../../../lib/llm/dispatch');
	return { ...actual, runLlmObject: runLlmObjectMock };
});

beforeEach(() => {
	runLlmObjectMock.mockReset();
	session.current = { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' };
});

const betterAuthModules = import.meta.glob('../../../betterAuth/**/*.*s');
const SENT = Date.UTC(2026, 9, 7, 9, 0);
const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

function harness(): Test {
	const t = convexTest(schema, modules);
	t.registerComponent('betterAuth', betterAuthSchema, betterAuthModules);
	rateLimiterTest.register(t);
	return t;
}

const ours = reduceItem();
const call = reduceItem({
	intent: 'request',
	facets: ['meeting'],
	consequences: [],
	assertion: 'Pick a time for a call',
	display: { en: 'Pick a time for a call', de: 'Such eine Zeit für ein Gespräch aus' },
	due: undefined,
});
const theirs = reduceItem({
	assertion: 'Confirm the venue',
	display: { en: 'Jonas confirms the venue', de: 'Jonas bestätigt den Ort' },
	responsible: { email: 'jonas@example.com', isUs: false },
	facets: ['meeting'],
	consequences: [],
	due: undefined,
});

/** A Postbox thread with two of our items and one of theirs, and a reply draft in it. */
async function setup(t: Test) {
	await enableFeatures(t, ['postbox', 'ai']);
	const { mailboxId, messageId, threadId } = await seedMailThread(t);
	const ref = { kind: 'mail' as const, id: threadId };
	await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
		source: { kind: 'mail', id: messageId },
		threadRef: ref,
		mode: 'brief',
		contentRevision: 'rev-1',
		extractorVersion: 1,
		expectedRevision: 0,
		deletionEpoch: 0,
		sourceAt: SENT,
		direction: 'inbound',
		status: 'complete',
		result: reduceResult({ items: [ours, call, theirs] }),
	});
	const items = await t.run(async (ctx) =>
		(await ctx.db.query('threadItems').collect()).filter((i) => i.mailThreadId === threadId)
	);
	// Unsealed in tests: no INSTANCE_SECRET, so the assertion is stored as written.
	const byText = (assertion: string) => items.find((i) => i.assertion === assertion)!;
	const draftId = await t.run((ctx) =>
		ctx.db.insert('mailDrafts', {
			mailboxId,
			threadId,
			toAddresses: ['jonas@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			fromAddress: 'me@owlat.test',
			subject: 'Re: Contract',
			bodyHtml: '<p>hi</p>',
			attachments: [],
			state: 'draft',
			lastEditedAt: SENT,
			createdAt: SENT,
		})
	);
	return {
		mailboxId,
		threadId,
		ref,
		draftRef: { kind: 'mailDraft' as const, id: draftId },
		draftId,
		ours: byText('Send the signed contract')._id,
		call: byText('Pick a time for a call')._id,
		theirs: byText('Confirm the venue')._id,
	};
}

describe('responsePlan.get', () => {
	it('returns default stances for our open items, never theirs, before any draft', async () => {
		const t = harness();
		const s = await setup(t);
		const view = await t.query(api.mail.interpret.responsePlan.get, { threadRef: s.ref });
		expect(view?.verdict).toBe('pending');
		expect(new Set(view?.stances.map((x) => x.itemId))).toEqual(new Set([s.ours, s.call]));
		expect(view?.stances.every((x) => x.stance === 'answer' && x.source === 'default')).toBe(true);
	});

	it('is null for a caller who cannot read the mailbox', async () => {
		const t = harness();
		const s = await setup(t);
		session.current = { userId: 'user-B', role: 'member', activeOrganizationId: 'org-1' };
		expect(
			await t.query(api.mail.interpret.responsePlan.get, { threadRef: s.ref, draftRef: s.draftRef })
		).toBeNull();
	});

	it('defaults an item with an unanswered Reply Queue question to clarify', async () => {
		const t = harness();
		const s = await setup(t);
		await t.run(async (ctx) => {
			const message = await ctx.db
				.query('mailMessages')
				.withIndex('by_thread', (q) => q.eq('threadId', s.threadId))
				.first();
			await ctx.db.patch(s.threadId, {
				needsReply: {
					messageId: message!._id,
					source: 'llm',
					urgency: 'normal',
					detectedAt: SENT,
					clarification: {
						isNeeded: true,
						askedAt: SENT,
						questions: [
							{ id: 'clarify_0', slotType: 'attachment', text: 'Which contract?', itemId: s.ours },
						],
					},
				},
			});
		});
		const loaded = await t.query(internal.mail.interpret.responsePlanDraft.loadForDraft, {
			threadRef: s.ref,
		});
		expect(loaded.stances.find((x) => x.itemId === s.ours)?.stance).toBe('clarify');
		expect(loaded.stances.find((x) => x.itemId === s.call)?.stance).toBe('answer');
	});
});

describe('responsePlan.setStances', () => {
	it('stores the owner’s stance and skip, and get reads them back', async () => {
		const t = harness();
		const s = await setup(t);
		await t.mutation(api.mail.interpret.responsePlan.setStances, {
			threadRef: s.ref,
			draftRef: s.draftRef,
			stances: [
				{ itemId: s.ours, stance: 'accept' },
				{ itemId: s.call, stance: 'skip' },
			],
		});
		const view = await t.query(api.mail.interpret.responsePlan.get, {
			threadRef: s.ref,
			draftRef: s.draftRef,
		});
		expect(view?.stances).toEqual(
			expect.arrayContaining([
				{ itemId: s.ours, stance: 'accept', source: 'owner' },
				{ itemId: s.call, stance: 'skip', source: 'owner' },
			])
		);
		// A later write keeps the earlier choice it does not mention.
		await t.mutation(api.mail.interpret.responsePlan.setStances, {
			threadRef: s.ref,
			draftRef: s.draftRef,
			stances: [{ itemId: s.call, stance: 'defer' }],
		});
		const again = await t.query(api.mail.interpret.responsePlan.get, {
			threadRef: s.ref,
			draftRef: s.draftRef,
		});
		expect(again?.stances.find((x) => x.itemId === s.ours)?.stance).toBe('accept');
		expect(again?.stances.find((x) => x.itemId === s.call)?.stance).toBe('defer');
	});

	it('refuses an item the reply does not cover', async () => {
		const t = harness();
		const s = await setup(t);
		await expect(
			t.mutation(api.mail.interpret.responsePlan.setStances, {
				threadRef: s.ref,
				draftRef: s.draftRef,
				stances: [{ itemId: s.theirs, stance: 'accept' }],
			})
		).rejects.toThrow(/not open in this thread/);
	});

	it('refuses a draft of another thread, and a caller without access', async () => {
		const t = harness();
		const s = await setup(t);
		const other = await seedMailThread(t, { address: 'other@owlat.test' });
		await expect(
			t.mutation(api.mail.interpret.responsePlan.setStances, {
				threadRef: { kind: 'mail', id: other.threadId },
				draftRef: s.draftRef,
				stances: [],
			})
		).rejects.toThrow(/not part of this thread/);
		session.current = { userId: 'user-B', role: 'member', activeOrganizationId: 'org-1' };
		await expect(
			t.mutation(api.mail.interpret.responsePlan.setStances, {
				threadRef: s.ref,
				draftRef: s.draftRef,
				stances: [{ itemId: s.ours, stance: 'accept' }],
			})
		).rejects.toThrow();
	});
});

describe('coverage.check', () => {
	const draft =
		'Hi Jonas,\nthe signed contract follows tomorrow. Tuesday at 10:00 works for the call. I’ve attached the agenda.';

	it('checks the draft against the plan, stores it sealed and get reads it', async () => {
		const t = harness();
		const s = await setup(t);
		runLlmObjectMock.mockResolvedValueOnce({
			object: {
				coverage: [
					{ ref: 'i1', verdict: 'addressed', quotes: ['the signed contract follows tomorrow.'] },
					{ ref: 'i2', verdict: 'addressed', quotes: ['Tuesday at 10:00 works for the call.'] },
				],
				fileClaims: [{ quote: 'I’ve attached the agenda.', file: 'agenda' }],
				promises: [
					{ quote: 'the signed contract follows tomorrow', itemRef: 'i1', due: 'tomorrow' },
				],
			},
			tokenUsage: USAGE,
			modelUsed: 'test-model',
		});
		const result = await t.action(api.mail.interpret.coverage.check, {
			threadRef: s.ref,
			draftRef: s.draftRef,
			draftText: draft,
			stances: [],
		});
		expect(result?.isChecked).toBe(true);
		expect(result?.coverage.map((c) => c.verdict)).toEqual(['addressed', 'addressed']);
		expect(result?.fileClaims).toEqual([expect.objectContaining({ isMatched: false })]);
		expect(result?.newPromises).toEqual([expect.objectContaining({ itemId: expect.any(String) })]);
		// The prompt fences the item text and carries the draft as data.
		const prompt = runLlmObjectMock.mock.calls[0]![0].prompt as string;
		expect(prompt).toContain('<untrusted_item_text>Send the signed contract</untrusted_item_text>');
		expect(prompt).toContain('<draft_reply>');

		const view = await t.query(api.mail.interpret.responsePlan.get, {
			threadRef: s.ref,
			draftRef: s.draftRef,
		});
		expect(view?.verdict).toBe('gaps'); // the agenda is not attached
		expect(view?.draftHash).toBe(result?.draftHash);
		expect(view?.fileClaims[0]?.text).toBe('I’ve attached the agenda.');
		expect(view?.newPromises[0]?.text).toBe('the signed contract follows tomorrow');
		expect(view?.isStale).toBe(false);

		// An item revision moved: the stored coverage reads as stale.
		await t.run(async (ctx) => {
			const item = (await ctx.db.get(s.ours))!;
			await ctx.db.patch(s.ours, { revision: item.revision + 1 });
		});
		const stale = await t.query(api.mail.interpret.responsePlan.get, {
			threadRef: s.ref,
			draftRef: s.draftRef,
		});
		expect(stale).toMatchObject({ isStale: true, verdict: 'stale' });
	});

	it('skips the model for an empty draft and still reports no coverage', async () => {
		const t = harness();
		const s = await setup(t);
		const result = await t.action(api.mail.interpret.coverage.check, {
			threadRef: s.ref,
			draftRef: s.draftRef,
			draftText: '   ',
			stances: [],
		});
		expect(result).toMatchObject({ isChecked: false, fileClaims: [], newPromises: [] });
		expect(runLlmObjectMock).not.toHaveBeenCalled();
	});

	it('returns null for a caller who cannot read the thread, before any model call', async () => {
		const t = harness();
		const s = await setup(t);
		session.current = { userId: 'user-B', role: 'member', activeOrganizationId: 'org-1' };
		expect(
			await t.action(api.mail.interpret.coverage.check, {
				threadRef: s.ref,
				draftRef: s.draftRef,
				draftText: draft,
				stances: [],
			})
		).toBeNull();
		expect(runLlmObjectMock).not.toHaveBeenCalled();
	});

	it('fails soft when the model fails: no verdicts, the attachment claim still counts', async () => {
		const t = harness();
		const s = await setup(t);
		runLlmObjectMock.mockRejectedValueOnce(new Error('model down'));
		const result = await t.action(api.mail.interpret.coverage.check, {
			threadRef: s.ref,
			draftRef: s.draftRef,
			draftText: draft,
			stances: [{ itemId: s.call, stance: 'skip' }],
		});
		expect(result?.isChecked).toBe(false);
		expect(result?.coverage.find((c) => c.itemId === s.call)?.verdict).toBe('skipped');
		expect(result?.fileClaims).toEqual([expect.objectContaining({ isMatched: false })]);
	});
});

describe('a draft’s plan goes with the draft', () => {
	it('discarding the draft deletes its plan', async () => {
		const t = harness();
		const s = await setup(t);
		await t.mutation(api.mail.interpret.responsePlan.setStances, {
			threadRef: s.ref,
			draftRef: s.draftRef,
			stances: [{ itemId: s.ours, stance: 'accept' }],
		});
		const count = () =>
			t.run(async (ctx) => (await ctx.db.query('draftResponsePlans').collect()).length);
		expect(await count()).toBe(1);
		await t.mutation(api.mail.drafts.discard, { draftId: s.draftId as Id<'mailDrafts'> });
		expect(await count()).toBe(0);
	});
});
