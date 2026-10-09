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
import {
	modules,
	reduceItem,
	reduceResult,
	seedMailThread,
	seedTeamThread,
	type Test,
} from './interpret.testlib';

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
			})
		).toBeNull();
		expect(runLlmObjectMock).not.toHaveBeenCalled();
	});

	it('fails soft when the model fails: no verdicts, the attachment claim still counts', async () => {
		const t = harness();
		const s = await setup(t);
		runLlmObjectMock.mockRejectedValueOnce(new Error('model down'));
		await t.mutation(api.mail.interpret.responsePlan.setStances, {
			threadRef: s.ref,
			draftRef: s.draftRef,
			stances: [{ itemId: s.call, stance: 'skip' }],
		});
		const result = await t.action(api.mail.interpret.coverage.check, {
			threadRef: s.ref,
			draftRef: s.draftRef,
			draftText: draft,
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

describe('review round 1', () => {
	const USAGE_ = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
	const empty = { coverage: [], fileClaims: [], promises: [] };

	it('F2/D1: a stance write bumps the revision and leaves the old check pending', async () => {
		const t = harness();
		const s = await setup(t);
		runLlmObjectMock.mockResolvedValue({ object: empty, tokenUsage: USAGE_, modelUsed: 'm' });
		const first = await t.action(api.mail.interpret.coverage.check, {
			threadRef: s.ref,
			draftRef: s.draftRef,
			draftText: 'Hello Jonas.',
		});
		expect(first).toMatchObject({ planRevision: 0, isStored: true });
		const { planRevision } = await t.mutation(api.mail.interpret.responsePlan.setStances, {
			threadRef: s.ref,
			draftRef: s.draftRef,
			stances: [{ itemId: s.ours, stance: 'decline' }],
		});
		expect(planRevision).toBe(1);
		const view = await t.query(api.mail.interpret.responsePlan.get, {
			threadRef: s.ref,
			draftRef: s.draftRef,
		});
		expect(view).toMatchObject({ planRevision: 1, checkedPlanRevision: 0, verdict: 'pending' });
	});

	it('F12: file claims and commitments are checked with every item skipped', async () => {
		const t = harness();
		const s = await setup(t);
		await t.mutation(api.mail.interpret.responsePlan.setStances, {
			threadRef: s.ref,
			draftRef: s.draftRef,
			stances: [
				{ itemId: s.ours, stance: 'skip' },
				{ itemId: s.call, stance: 'skip' },
			],
		});
		runLlmObjectMock.mockResolvedValueOnce({
			object: {
				...empty,
				promises: [{ quote: 'I will refund you', itemRef: null, due: null, amount: null }],
			},
			tokenUsage: USAGE_,
			modelUsed: 'm',
		});
		const result = await t.action(api.mail.interpret.coverage.check, {
			threadRef: s.ref,
			draftRef: s.draftRef,
			draftText: 'I will refund you. I’ve attached the receipt.',
		});
		expect(runLlmObjectMock).toHaveBeenCalledTimes(1);
		expect(result?.newPromises).toHaveLength(1);
		expect(result?.fileClaims).toEqual([expect.objectContaining({ isMatched: false })]);
	});

	it('F1/D2: items past the bound are counted as overflow, not dropped silently', async () => {
		const t = harness();
		const s = await setup(t);
		await t.run(async (ctx) => {
			const template = (await ctx.db.get(s.ours))!;
			const { _id, _creationTime, ...fields } = template;
			for (let i = 0; i < 205; i++) {
				await ctx.db.insert('threadItems', { ...fields, askedAt: SENT + i });
			}
		});
		const loaded = await t.query(internal.mail.interpret.responsePlanDraft.loadForDraft, {
			threadRef: s.ref,
		});
		expect(loaded.isOverflow).toBe(true);
		expect(loaded.items.length).toBe(200);
		const view = await t.query(api.mail.interpret.responsePlan.get, { threadRef: s.ref });
		expect(view?.isCheckIncomplete).toBe(true);
	});

	it('F16: the prepared reply’s plan moves to the Postbox draft made from it', async () => {
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
					draftSlot: { draft: 'Prepared.', confidence: 0.8, generatedAt: SENT },
				},
			});
		});
		const arrival = { kind: 'arrivalDraft' as const, id: s.threadId };
		expect(
			await t.mutation(internal.mail.interpret.responsePlanDraft.recordCheck, {
				threadRef: s.ref,
				draftRef: arrival,
				threadRevision: 1,
				itemRevisions: [],
				stances: [],
				coverage: [],
				fileClaims: [],
				newPromises: [],
				draftHash: 'prepared-hash',
				verdict: 'covered',
				planRevision: 0,
				deletionEpoch: 0,
				attachmentSetHash: 'none',
				isCheckIncomplete: false,
			})
		).toEqual({ isStored: true });
		await t.mutation(api.mail.interpret.responsePlan.adoptArrivalPlan, {
			threadRef: s.ref,
			draftId: s.draftId,
		});
		const rows = await t.run((ctx) => ctx.db.query('draftResponsePlans').collect());
		expect(rows).toEqual([
			expect.objectContaining({
				draftKind: 'mailDraft',
				mailDraftId: s.draftId,
				draftHash: 'prepared-hash',
			}),
		]);
	});
});

describe('review round 2: the team context reads the answered message (F2)', () => {
	it('takes the target’s message, the newest without one, and refuses another thread’s', async () => {
		const t = harness();
		const { threadId, inboundId } = await seedTeamThread(t);
		const other = await seedTeamThread(t);
		const newer = await t.run((ctx) =>
			ctx.db.insert('inboundMessages', {
				messageId: '<order-42-b@example.com>',
				from: 'customer@example.com',
				to: 'support@owlat.test',
				subject: 'Order 42, again',
				textBody: 'Any news?',
				processingStatus: 'received',
				receivedAt: SENT + 60_000,
				threadId,
			})
		);
		const load = (inboundMessageId?: Id<'inboundMessages'>) =>
			t.query(internal.mail.ai.composeDraftContext.loadTeamThreadContext, {
				threadId,
				...(inboundMessageId ? { inboundMessageId } : {}),
			});
		expect((await load()).inboundMessageId).toBe(newer);
		expect((await load(inboundId)).inboundMessageId).toBe(inboundId);
		await expect(load(other.inboundId)).rejects.toThrow();
	});
});

describe('review round 3', () => {
	it('F1: a stored check reads as stale once an item it covered is closed', async () => {
		const t = harness();
		const s = await setup(t);
		const loaded = await t.query(internal.mail.interpret.responsePlanDraft.loadForDraft, {
			threadRef: s.ref,
			draftRef: s.draftRef,
		});
		await t.mutation(internal.mail.interpret.responsePlanDraft.recordCheck, {
			threadRef: s.ref,
			draftRef: s.draftRef,
			threadRevision: loaded.threadRevision,
			itemRevisions: loaded.items.map((i) => ({ itemId: i.id, revision: i.revision })),
			stances: loaded.stances,
			coverage: loaded.items.map((i) => ({
				itemId: i.id,
				verdict: 'addressed' as const,
				spans: [],
			})),
			fileClaims: [],
			newPromises: [],
			draftHash: 'h',
			verdict: 'covered',
			planRevision: 0,
			deletionEpoch: loaded.deletionEpoch,
			attachmentSetHash: loaded.attachmentSetHash,
			isCheckIncomplete: false,
		});
		const before = await t.query(api.mail.interpret.responsePlan.get, {
			threadRef: s.ref,
			draftRef: s.draftRef,
		});
		expect(before).toMatchObject({ isStale: false, verdict: 'covered' });
		expect(before?.checkedItemRevisions).toHaveLength(2);
		// "Mark done": the item leaves the open set; the thread revision stays.
		await t.run((ctx) => ctx.db.patch(s.call, { status: 'done' }));
		const after = await t.query(api.mail.interpret.responsePlan.get, {
			threadRef: s.ref,
			draftRef: s.draftRef,
		});
		expect(after).toMatchObject({ isStale: true, verdict: 'stale' });
	});
});

describe('review round 4', () => {
	it('F1: a stance for an item closed since is skipped, not refused', async () => {
		const t = harness();
		const s = await setup(t);
		await t.run((ctx) => ctx.db.patch(s.call, { status: 'done' }));
		const { planRevision } = await t.mutation(api.mail.interpret.responsePlan.setStances, {
			threadRef: s.ref,
			draftRef: s.draftRef,
			stances: [
				{ itemId: s.call, stance: 'decline' },
				{ itemId: s.ours, stance: 'accept' },
			],
		});
		expect(planRevision).toBe(1);
		const view = await t.query(api.mail.interpret.responsePlan.get, {
			threadRef: s.ref,
			draftRef: s.draftRef,
		});
		expect(view?.stances).toEqual([{ itemId: s.ours, stance: 'accept', source: 'owner' }]);
		// The other side's open item is still not this reply's to cover.
		await expect(
			t.mutation(api.mail.interpret.responsePlan.setStances, {
				threadRef: s.ref,
				draftRef: s.draftRef,
				stances: [{ itemId: s.theirs, stance: 'accept' }],
			})
		).rejects.toThrow(/not open in this thread/);
	});
});
