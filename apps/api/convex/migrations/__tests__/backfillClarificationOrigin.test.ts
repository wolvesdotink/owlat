/**
 * Migration 0066: legacy clarification questions (only the English
 * `attribution` sentence) get the `origin` the sentence implies and lose the
 * sentence, on Reply Queue threads and Answer mode sessions alike, so a later
 * release can drop the field and the web's sentence-parsing fallback.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import {
	modules,
	seedFolder,
	seedMailbox,
	seedMessage,
} from '../../mail/__tests__/helpers.testlib';
import { legacyAttributionOrigin } from '../../inbox/clarificationSlots';
import {
	MIGRATION,
	convertQuestions,
	decodeCursor,
	encodeCursor,
} from '../0066_backfill_clarification_origin';

const migration = internal.migrations[MIGRATION];

type Harness = TestConvex<typeof schema>;

const legacy = (domain?: string) =>
	`Generated from ${domain ? `an email from ${domain}` : 'an email'} — Owlat will never ask for your password.`;

describe('legacyAttributionOrigin', () => {
	it('reads the domain the way the web fallback does', () => {
		expect(legacyAttributionOrigin(legacy('acme.com'))).toEqual({
			kind: 'email',
			senderDomain: 'acme.com',
		});
		expect(legacyAttributionOrigin('Generated from an email from acme.com.')).toEqual({
			kind: 'email',
			senderDomain: 'acme.com',
		});
	});

	it('keeps an email origin without a domain when the sentence names none', () => {
		expect(legacyAttributionOrigin(legacy())).toEqual({ kind: 'email' });
		expect(legacyAttributionOrigin('Asked because Bob referenced a PO')).toEqual({ kind: 'email' });
	});

	it('gives no origin for an absent or empty sentence, which shows no line', () => {
		expect(legacyAttributionOrigin(undefined)).toBeUndefined();
		expect(legacyAttributionOrigin('')).toBeUndefined();
	});
});

describe('convertQuestions', () => {
	it('returns null when no question carries the legacy sentence', () => {
		expect(convertQuestions([{ id: 'a', origin: { kind: 'email' as const } }, { id: 'b' }])).toBe(
			null
		);
	});

	it('converts legacy questions and keeps an origin that is already there', () => {
		expect(
			convertQuestions([
				{ id: 'a', attribution: legacy('acme.com') },
				{
					id: 'b',
					attribution: legacy('stale.example'),
					origin: { kind: 'email' as const, senderDomain: 'acme.com' },
				},
				{ id: 'c', origin: { kind: 'email' as const } },
				{ id: 'd', attribution: '' },
			])
		).toEqual([
			{ id: 'a', origin: { kind: 'email', senderDomain: 'acme.com' } },
			{ id: 'b', origin: { kind: 'email', senderDomain: 'acme.com' } },
			{ id: 'c', origin: { kind: 'email' } },
			{ id: 'd' },
		]);
	});
});

describe('cursor', () => {
	it('starts on the threads pass and round-trips both passes', () => {
		expect(decodeCursor(undefined)).toEqual({ pass: 'threads', cursor: null });
		expect(decodeCursor(encodeCursor('threads', 'abc'))).toEqual({
			pass: 'threads',
			cursor: 'abc',
		});
		expect(decodeCursor(encodeCursor('sessions', null))).toEqual({
			pass: 'sessions',
			cursor: null,
		});
	});
});

async function seedLegacyThread(
	t: Harness,
	mailboxId: Id<'mailboxes'>,
	subject: string,
	questions: {
		id: string;
		attribution?: string;
		origin?: { kind: 'email'; senderDomain?: string };
	}[]
): Promise<Id<'mailThreads'>> {
	const messageId = await seedMessage(t, mailboxId, { subject });
	return t.run(async (ctx) => {
		const message = (await ctx.db.get(messageId))!;
		await ctx.db.patch(message.threadId, {
			needsReply: {
				messageId,
				source: 'llm',
				urgency: 'normal',
				detectedAt: 1,
				askSummary: 'Which PO applies?',
				clarification: {
					isNeeded: true,
					askedAt: 1,
					questions: questions.map((q) => ({
						slotType: 'factual_lookup',
						text: 'Which PO number applies?',
						...q,
					})),
				},
			},
		});
		return message.threadId;
	});
}

async function seedLegacySession(t: Harness, mailboxId: Id<'mailboxes'>, attribution: string) {
	return t.run(async (ctx) => {
		const now = Date.now();
		const draftId = await ctx.db.insert('mailDrafts', {
			mailboxId,
			toAddresses: ['ines@northwind.example'],
			ccAddresses: [],
			bccAddresses: [],
			fromAddress: 'a@owlat.test',
			subject: 'Re: invoice',
			bodyHtml: '<p>hi</p>',
			attachments: [],
			state: 'draft' as const,
			lastEditedAt: now,
			createdAt: now,
		});
		return ctx.db.insert('answerAskSessions', {
			ownerId: 'user-A',
			organizationId: 'org-1',
			target: { kind: 'mailDraft', draftId },
			targetKey: `mailDraft:${draftId}`,
			locale: 'en',
			round: 1,
			status: 'asking',
			questions: [
				{
					id: 'file_request',
					slotType: 'attachment',
					text: 'They asked for "invoice".',
					attribution,
					answerKind: 'file',
					answer: { value: 'It isn’t ready yet', at: now, source: 'user' },
				},
			],
			attachedFiles: [],
			createdAt: now,
			updatedAt: now,
		});
	});
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('0066_backfill_clarification_origin', () => {
	it('converts every legacy question on threads and sessions, over several pages', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const legacyThread = await seedLegacyThread(t, mailboxId, 'legacy', [
			{ id: 'clarify_0', attribution: legacy('acme.com') },
			{ id: 'clarify_1', attribution: legacy() },
		]);
		const mixedThread = await seedLegacyThread(t, mailboxId, 'mixed', [
			{
				id: 'clarify_0',
				attribution: legacy('stale.example'),
				origin: { kind: 'email', senderDomain: 'acme.com' },
			},
		]);
		const currentThread = await seedLegacyThread(t, mailboxId, 'current', [
			{ id: 'clarify_0', origin: { kind: 'email', senderDomain: 'acme.com' } },
		]);
		// Enough plain threads that the walk takes more than one page.
		for (let i = 0; i < 110; i++) await seedMessage(t, mailboxId, { subject: `plain ${i}` });
		const sessionId = await seedLegacySession(t, mailboxId, legacy('northwind.example'));
		const before = await t.run(async (ctx) => (await ctx.db.get(currentThread))!);

		await t.mutation(migration.run, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		await t.run(async (ctx) => {
			const converted = (await ctx.db.get(legacyThread))!;
			expect(converted.needsReply?.clarification?.questions).toEqual([
				expect.objectContaining({
					id: 'clarify_0',
					origin: { kind: 'email', senderDomain: 'acme.com' },
				}),
				expect.objectContaining({ id: 'clarify_1', origin: { kind: 'email' } }),
			]);
			for (const q of converted.needsReply!.clarification!.questions) {
				expect(q).not.toHaveProperty('attribution');
			}
			// The rest of the flag is untouched.
			expect(converted.needsReply).toMatchObject({
				askSummary: 'Which PO applies?',
				clarification: { isNeeded: true, askedAt: 1 },
			});

			const mixed = (await ctx.db.get(mixedThread))!;
			expect(mixed.needsReply?.clarification?.questions[0]).toEqual(
				expect.objectContaining({ origin: { kind: 'email', senderDomain: 'acme.com' } })
			);
			expect(mixed.needsReply?.clarification?.questions[0]).not.toHaveProperty('attribution');

			// A thread with nothing to convert is not written.
			expect(await ctx.db.get(currentThread)).toEqual(before);

			const session = (await ctx.db.get(sessionId))!;
			expect(session.questions[0]).toEqual(
				expect.objectContaining({
					origin: { kind: 'email', senderDomain: 'northwind.example' },
					answer: expect.objectContaining({ value: 'It isn’t ready yet' }),
				})
			);
			expect(session.questions[0]).not.toHaveProperty('attribution');

			const run = await ctx.db
				.query('migrationRuns')
				.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
				.unique();
			expect(run).toMatchObject({ status: 'completed', changedCount: 3 });
			expect(run!.pageCount).toBeGreaterThan(2);
		});

		// Finished: a second run does nothing.
		expect(await t.mutation(migration.run, {})).toMatchObject({ started: false });
	});
});
