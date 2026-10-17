/**
 * The digest (SPEC §6.5): selection (newest 200, ≤5 lines per kind, per-kind
 * overflow, exact or "200+"), the claim with its attempt bound, one batched
 * `mail.digest` call with allowlisted refs and verbatim spans, the commit
 * through the one guarded writer, digest-only eligibility in `listDue`, and
 * delivery in ONE mutation: idempotent, consuming each thread through its
 * boundary while late mail stays pending.
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import type { Id } from '../../../_generated/dataModel';
import { internal } from '../../../_generated/api';
import { enableFeatures } from '../../../__tests__/factories';
import { modules } from '../../__tests__/helpers.testlib';
import { localMinuteOfDay } from '../../briefEmail';
import { digestOutputSchema } from '../generate';
import { DIGEST_MAX_VISITED, selectDigest, type DigestCandidate } from '../select';
import { MAX_DIGEST_ATTEMPTS } from '../claim';
import { openStoredInlineBody } from '../../../lib/messageBodyStore';
import {
	deliverHosted,
	seedPersonalMailbox,
	seedProfile,
	type T,
} from '../../rules/__tests__/rules.testlib';

const llm = vi.hoisted(() => ({ runLlmObject: vi.fn() }));

vi.mock('../../../lib/llm/dispatch', async () => {
	const { metered } = await import('../../../analytics/__tests__/meteredDispatch.testlib');
	return { runLlmObject: metered((opts: unknown) => llm.runLlmObject(opts)) };
});
vi.mock('../../../lib/llmProvider', () => ({
	resolveLanguageModel: vi.fn(async () => ({ modelId: 'stub-model' })),
}));

const digestCalls = () =>
	llm.runLlmObject.mock.calls.filter(
		([opts]) => (opts as { schema: unknown }).schema === digestOutputSchema
	);

const NOW = Date.UTC(2026, 9, 17, 18, 0);

beforeEach(() => {
	llm.runLlmObject.mockReset();
	llm.runLlmObject.mockImplementation(async ({ prompt }: { prompt: string }) => {
		const refs = [...prompt.matchAll(/ref="(\d+)"/g)].map((m) => Number(m[1]));
		return {
			object: {
				lines: [
					// Ref 1: verbatim. Ref 2: paraphrased, dropped. Ref 99: not offered.
					...refs
						.filter((ref) => ref === 1)
						.map((ref) => ({ ref, spans: [{ segment: 's0', quote: 'Everything is on sale.' }] })),
					...refs
						.filter((ref) => ref === 2)
						.map((ref) => ({ ref, spans: [{ segment: 's0', quote: 'Big savings inside!' }] })),
					{ ref: 99, spans: [{ segment: 's0', quote: 'Everything is on sale.' }] },
				],
			},
			tokenUsage: undefined,
			modelUsed: 'stub-model',
		};
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe('selectDigest', () => {
	const candidate = (i: number, kind: DigestCandidate['kind']): DigestCandidate => ({
		threadId: `t${i}` as Id<'mailThreads'>,
		messageId: `m${i}` as Id<'mailMessages'>,
		throughSourceOrderKey: `k${i}`,
		kind,
	});

	it('renders the newest 5 per kind and counts every other visited thread', () => {
		const candidates = [
			...Array.from({ length: 12 }, (_, i) => candidate(i, 'newsletter')),
			...Array.from({ length: 3 }, (_, i) => candidate(100 + i, 'updates')),
		];
		const selection = selectDigest(candidates);
		expect(selection.items.filter((item) => item.kind === 'newsletter')).toHaveLength(5);
		expect(selection.items.filter((item) => item.kind === 'updates')).toHaveLength(3);
		expect(selection.overflowByKind).toEqual({ newsletter: 7, updates: 0, promotion: 0 });
		expect(selection.overflowLabel).toBe('exact');
		expect(selection.visited).toHaveLength(15);
		expect(selection.visited[0]).toEqual({
			threadId: 't0',
			throughSourceOrderKey: 'k0',
			kind: 'newsletter',
		});
	});

	it('visits at most 200 and labels the overflow "at least" past that', () => {
		const candidates = Array.from({ length: DIGEST_MAX_VISITED + 1 }, (_, i) =>
			candidate(i, 'promotion')
		);
		const selection = selectDigest(candidates);
		expect(selection.visited).toHaveLength(DIGEST_MAX_VISITED);
		expect(selection.overflowByKind.promotion).toBe(DIGEST_MAX_VISITED - 5);
		expect(selection.overflowLabel).toBe('at_least');
	});
});

/** A personal mailbox with `count` digest threads from a sender set to Digest. */
async function digestSetup(count: number, opts: { briefEmail?: boolean } = {}) {
	vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await enableFeatures(t, ['ai', 'postbox']);
	const { mailboxId } = await seedPersonalMailbox(t);
	await seedProfile(t, mailboxId, { status: 'digest', statusSource: 'user' });
	const messageIds: Id<'mailMessages'>[] = [];
	for (let i = 0; i < count; i += 1) {
		messageIds.push((await deliverHosted(t, { subject: `Sale ${i}`, id: `d${i}` }))!);
	}
	if (opts.briefEmail) {
		await t.run(async (ctx) => {
			await ctx.db.insert('mailUserSettings', {
				userId: 'user-A',
				autoAdvance: 'next',
				dailyBriefEmail: { enabled: true, minute: localMinuteOfDay(NOW, 0), utcOffsetMinutes: 0 },
				createdAt: 1,
				updatedAt: 1,
			});
		});
	}
	return { t, mailboxId, messageIds };
}

async function threadOf(t: T, messageId: Id<'mailMessages'>) {
	return await t.run(async (ctx) => {
		const message = (await ctx.db.get(messageId))!;
		return (await ctx.db.get(message.threadId))!;
	});
}

async function digestsOf(t: T, mailboxId: Id<'mailboxes'>) {
	return await t.run(
		async (ctx) =>
			await ctx.db
				.query('mailDigests')
				.withIndex('by_mailbox_period', (q) => q.eq('mailboxId', mailboxId))
				.collect()
	);
}

describe('eligibility and the claim', () => {
	it('marks digest-placed threads pending, and listDue sends a digest-only brief', async () => {
		const { t, messageIds } = await digestSetup(2, { briefEmail: true });
		const thread = await threadOf(t, messageIds[0]!);
		expect(thread.arrival?.placement).toBe('digest');
		expect(thread.digestPendingSince).toBeDefined();
		const due = await t.query(internal.mail.briefEmail.listDue, { now: NOW });
		expect(due).toHaveLength(1);
		expect(due[0]!.items).toEqual([]);
		expect(due[0]!.digestPeriodKey).toBe(`day:${Math.floor(NOW / 86_400_000)}`);
	});

	it('holds a live claim, re-claims a dead one, and stops paying after two attempts', async () => {
		const { t, mailboxId } = await digestSetup(1);
		const claim = (now: number) =>
			t.mutation(internal.mail.digest.claim.claimDigest, { mailboxId, periodKey: 'p', now });
		const first = await claim(NOW);
		expect(first).toMatchObject({ kind: 'claimed', isPaid: true });
		expect((await claim(NOW + 1_000)).kind).toBe('busy');
		const second = await claim(NOW + 10 * 60_000);
		expect(second).toMatchObject({ kind: 'claimed', isPaid: true });
		const third = await claim(NOW + 20 * 60_000);
		expect(third).toMatchObject({ kind: 'claimed', isPaid: false });
		const [row] = await digestsOf(t, mailboxId);
		expect(row!.generationAttempts).toBe(MAX_DIGEST_ATTEMPTS);
		expect(row!.items).toEqual([]);
	});

	it('commits only through a live claim, and drops a fenced or purged line', async () => {
		const { t, mailboxId, messageIds } = await digestSetup(3);
		const claim = await t.mutation(internal.mail.digest.claim.claimDigest, {
			mailboxId,
			periodKey: 'p',
		});
		if (claim.kind !== 'claimed') throw new Error('expected a claim');
		const fenced = await threadOf(t, messageIds[0]!);
		await t.run(async (ctx) => {
			await ctx.db.patch(fenced._id, { interpretationStaleSince: NOW });
			await ctx.db.delete(messageIds[1]!);
		});
		expect(
			await t.mutation(internal.mail.digest.claim.commitDigest, {
				digestId: claim.digestId,
				claimToken: 'wrong',
				items: claim.items,
			})
		).toBe(false);
		expect(
			await t.mutation(internal.mail.digest.claim.commitDigest, {
				digestId: claim.digestId,
				claimToken: claim.claimToken,
				items: claim.items,
			})
		).toBe(true);
		const [row] = await digestsOf(t, mailboxId);
		expect(row!.state).toBe('generated');
		expect(row!.items.map((item) => item.messageId)).toEqual([messageIds[2]]);
	});
});

describe('generation and delivery', () => {
	it('sends one brief with the digest after one batched call, then consumes the threads', async () => {
		const { t, mailboxId, messageIds } = await digestSetup(3, { briefEmail: true });
		const result = await t.action(internal.mail.briefEmailActions.deliverDueBriefs, {});
		expect(result.delivered).toBe(1);
		expect(digestCalls()).toHaveLength(1);
		const prompt = (digestCalls()[0]![0] as { prompt: string }).prompt;
		expect(prompt.match(/<untrusted_email_content ref=/g)).toHaveLength(3);

		const [digest] = await digestsOf(t, mailboxId);
		expect(digest).toMatchObject({ state: 'sent', items: [] });
		expect(digest!.visited).toHaveLength(3);
		for (const id of messageIds) {
			const thread = await threadOf(t, id);
			expect(thread.digestPendingSince).toBeUndefined();
			expect(thread.digestConsumedThrough).toBe(thread.arrival?.sourceOrderKey);
		}
		const { sent, html } = await t.run(async (ctx) => {
			const row = (await ctx.db.get(digest!.sentMessageId!))!;
			return { sent: row, html: (await openStoredInlineBody(ctx.db, row)).html ?? '' };
		});
		expect(sent.subject).toBe('Your daily brief — your digest');
		// The verbatim span is shown; the paraphrase and the foreign ref are not.
		expect(html).toContain('Everything is on sale.');
		expect(html).not.toContain('Big savings inside!');
		expect(html).toContain('Your digest');
		expect(html).toMatch(/Newsletters|Updates|Promotions/);
		expect(html).toContain(`/dashboard/postbox/inbox/${messageIds[0]}`);
	});

	it('delivers once: a second delivery of the same digest does nothing', async () => {
		const { t, mailboxId } = await digestSetup(1, { briefEmail: true });
		const claim = await t.mutation(internal.mail.digest.claim.claimDigest, {
			mailboxId,
			periodKey: 'p',
		});
		if (claim.kind !== 'claimed') throw new Error('expected a claim');
		await t.mutation(internal.mail.digest.claim.commitDigest, {
			digestId: claim.digestId,
			claimToken: claim.claimToken,
			items: claim.items,
		});
		const deliver = async () => {
			const rawStorageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(['raw'])));
			return await t.mutation(internal.mail.briefEmail.deliverBriefEmail, {
				userId: 'user-A',
				mailboxId,
				rawStorageId,
				rawSize: 3,
				messageId: `<brief-${Math.random()}@owlat.test>`,
				subject: 'Your daily brief — your digest',
				bodyText: 'digest',
				bodyHtml: '<p>digest</p>',
				snippet: 'digest',
				digest: { digestId: claim.digestId, claimToken: claim.claimToken },
			});
		};
		expect(await deliver()).toEqual({ delivered: true });
		expect(await deliver()).toEqual({ delivered: false });
		const briefs = await t.run(
			async (ctx) =>
				await ctx.db
					.query('mailMessages')
					.withIndex('by_mailbox_and_from', (q) =>
						q.eq('mailboxId', mailboxId).eq('fromAddress', 'me@owlat.test')
					)
					.collect()
		);
		expect(briefs).toHaveLength(1);
	});

	it('keeps a thread pending when mail arrived after the selection', async () => {
		const { t, mailboxId, messageIds } = await digestSetup(2);
		const claim = await t.mutation(internal.mail.digest.claim.claimDigest, {
			mailboxId,
			periodKey: 'p',
		});
		if (claim.kind !== 'claimed') throw new Error('expected a claim');
		await t.mutation(internal.mail.digest.claim.commitDigest, {
			digestId: claim.digestId,
			claimToken: claim.claimToken,
			items: claim.items,
		});
		// A newer inbound message lands in the first thread before the send.
		const late = await threadOf(t, messageIds[0]!);
		const boundary = late.arrival!.sourceOrderKey!;
		await t.run(async (ctx) => {
			await ctx.db.patch(late._id, {
				arrival: { ...late.arrival!, sourceOrderKey: `${boundary}~later` },
			});
		});
		const rawStorageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(['raw'])));
		await t.mutation(internal.mail.briefEmail.deliverBriefEmail, {
			userId: 'user-A',
			mailboxId,
			rawStorageId,
			rawSize: 3,
			messageId: '<brief@owlat.test>',
			subject: 's',
			bodyText: 'b',
			bodyHtml: '<p>b</p>',
			snippet: 'b',
			digest: { digestId: claim.digestId, claimToken: claim.claimToken },
		});
		const stillPending = await threadOf(t, messageIds[0]!);
		expect(stillPending.digestConsumedThrough).toBe(boundary);
		expect(stillPending.digestPendingSince).toBeDefined();
		const consumed = await threadOf(t, messageIds[1]!);
		expect(consumed.digestPendingSince).toBeUndefined();
	});

	it('holds at most one generated digest per mailbox across periods', async () => {
		const { t, mailboxId } = await digestSetup(1);
		for (const periodKey of ['a', 'b']) {
			const claim = await t.mutation(internal.mail.digest.claim.claimDigest, {
				mailboxId,
				periodKey,
			});
			if (claim.kind !== 'claimed') throw new Error('expected a claim');
			await t.mutation(internal.mail.digest.claim.commitDigest, {
				digestId: claim.digestId,
				claimToken: claim.claimToken,
				items: claim.items,
			});
		}
		const states = (await digestsOf(t, mailboxId)).map((row) => [row.periodKey, row.state]);
		expect(states.sort()).toEqual([
			['a', 'failed'],
			['b', 'generated'],
		]);
	});
});
