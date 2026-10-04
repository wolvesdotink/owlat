/**
 * Migration 0066: legacy clarification questions (only the English
 * `attribution` sentence) get the `origin` the sentence implies and lose the
 * sentence, on Reply Queue threads and Answer mode sessions alike.
 *
 * Since #1224 the schema has no `attribution`, so the current schema cannot
 * hold such a row and a deployment that still has one rejects the deploy. The
 * conversion is exercised against the same tables with schema validation off,
 * which stands in for the data a 0.6.10 deployment holds before 0066 has run.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { defineSchema } from 'convex/server';
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
import {
	MIGRATION,
	convertQuestions,
	decodeCursor,
	encodeCursor,
	legacyAttributionOrigin,
} from '../0066_backfill_clarification_origin';

const migration = internal.migrations[MIGRATION];

/**
 * The current tables with schema validation off: the rows a deployment held
 * before 0066 converted them, which the current schema no longer accepts.
 */
const legacySchema = defineSchema(schema.tables, { schemaValidation: false });

type Harness = TestConvex<typeof legacySchema>;

interface LegacyQuestion {
	id: string;
	attribution?: string;
	origin?: { kind: 'email'; senderDomain?: string };
}

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
	questions: LegacyQuestion[]
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
	const now = Date.now();
	// A stored question from before 0.6.10; the schema type no longer has the field.
	const legacyFileQuestion = {
		id: 'file_request',
		slotType: 'attachment',
		text: 'They asked for "invoice".',
		attribution,
		answerKind: 'file' as const,
		answer: { value: 'It isn’t ready yet', at: now, source: 'user' as const },
	};
	return t.run(async (ctx) => {
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
			questions: [legacyFileQuestion],
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
		const t = convexTest(legacySchema, modules);
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

	it('converts a question stored behind the cursor on a restart', async () => {
		// #1224 step 1: an action that started before the 0.6.10 deploy can store
		// a question with `attribution` after the walk has passed its thread.
		const t = convexTest(legacySchema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		await t.mutation(migration.run, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const late = await seedLegacyThread(t, mailboxId, 'late', [
			{ id: 'clarify_0', attribution: legacy('acme.com') },
		]);

		expect(await t.mutation(migration.run, {})).toMatchObject({ started: false });
		expect(await t.mutation(migration.run, { restart: true })).toMatchObject({ started: true });
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		await t.run(async (ctx) => {
			expect((await ctx.db.get(late))!.needsReply?.clarification?.questions).toEqual([
				expect.objectContaining({ origin: { kind: 'email', senderDomain: 'acme.com' } }),
			]);
			const run = await ctx.db
				.query('migrationRuns')
				.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
				.unique();
			expect(run).toMatchObject({ status: 'completed', changedCount: 1 });
		});
	});
});

describe('the schema without `attribution` (#1224)', () => {
	it('rejects a stored question that still has the legacy sentence', async () => {
		// convex-test validates writes against the schema the way the deployment
		// validates its stored rows on deploy.
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		await expect(
			seedLegacyThread(t, mailboxId, 'legacy', [
				{ id: 'clarify_0', attribution: legacy('acme.com') },
			])
		).rejects.toThrow(/Unexpected field `attribution`/);
		await expect(
			seedLegacySession(t, mailboxId, legacy('acme.com'))
		).rejects.toThrow(/Unexpected field `attribution`/);
	});

	it('leaves nothing for a run to change once the field is gone', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const current = await seedLegacyThread(t, mailboxId, 'current', [
			{ id: 'clarify_0', origin: { kind: 'email', senderDomain: 'acme.com' } },
		]);
		const before = await t.run(async (ctx) => (await ctx.db.get(current))!);

		await t.mutation(migration.run, { restart: true });
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		await t.run(async (ctx) => {
			expect(await ctx.db.get(current)).toEqual(before);
			const run = await ctx.db
				.query('migrationRuns')
				.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
				.unique();
			expect(run).toMatchObject({ status: 'completed', changedCount: 0 });
		});
	});
});
