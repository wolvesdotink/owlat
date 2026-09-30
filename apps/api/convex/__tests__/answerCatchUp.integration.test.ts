/**
 * Answer mode's catch-up card for Postbox threads (mail/ai/catchUp.ts +
 * mail/ai/catchUpStore.ts) with the LLM dispatch seam MOCKED:
 *
 *   - a cold cache generates once, stores, and the next call is a hit with no
 *     dispatch; a new message makes the row stale and regenerates it
 *   - model citations map to real message ids; a sentence citing nothing it
 *     was shown is dropped, an ask from an unknown message is dropped
 *   - the threshold: 3+ messages or a long newest message get the full card, a
 *     short thread gets asks only and shows only with two or more
 *   - readers only, the `ai` flag, fail-soft on a dispatch error
 *   - the coverage check keeps only real ask ids and skips the model when
 *     there is nothing to check
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';
import { rebuildThreadAggregates } from '../mail/threadAggregates';

const session = vi.hoisted(() => ({
	current: { userId: 'test-user', role: 'owner', activeOrganizationId: 'test-org' },
}));
const runLlmObjectMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session.current),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session.current),
		getBetterAuthSessionWithRole: vi.fn(async () => session.current),
	};
});

vi.mock('../lib/llmProvider', async () => {
	const actual = await vi.importActual<typeof import('../lib/llmProvider')>('../lib/llmProvider');
	return { ...actual, resolveLanguageModel: vi.fn(() => 'test-model') };
});

vi.mock('../lib/llm/dispatch', async () => {
	const actual = await vi.importActual<typeof import('../lib/llm/dispatch')>('../lib/llm/dispatch');
	return { ...actual, runLlmObject: runLlmObjectMock };
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('visualizationAgent') &&
			!path.includes('semanticFileProcessing')
	)
);

const OWNER = 'me@example.com';
const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

beforeEach(() => {
	runLlmObjectMock.mockReset();
	session.current = { userId: 'test-user', role: 'owner', activeOrganizationId: 'test-org' };
});

function modelReturns(object: unknown) {
	runLlmObjectMock.mockResolvedValueOnce({ object, tokenUsage: USAGE, modelUsed: 'test-model' });
}

type Harness = TestConvex<typeof schema>;

async function setup(flags: Array<'ai'> = ['ai']): Promise<Harness> {
	const t = convexTest(schema, modules);
	await enableFeatures(t, ['mail.external']);
	rateLimiterTest.register(t);
	if (flags.length) await enableFeatures(t, flags);
	return t;
}

/** A thread of `bodies` (oldest first); `fromOwner` marks the owner's messages by index. */
async function seedThread(
	t: Harness,
	bodies: string[],
	fromOwner: number[] = []
): Promise<{ threadId: Id<'mailThreads'>; messageIds: Id<'mailMessages'>[] }> {
	return t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'test-user',
			organizationId: 'test-org',
			address: OWNER,
			domain: 'example.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const folderId = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'INBOX',
			role: 'inbox',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 0,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'order',
			participants: ['ada@example.com', OWNER],
			messageCount: bodies.length,
			unreadCount: 0,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'hello',
			latestFromAddress: 'ada@example.com',
			latestSubject: 'Order',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		const messageIds: Id<'mailMessages'>[] = [];
		for (const [i, body] of bodies.entries()) {
			const rawStorageId = await ctx.storage.store(new Blob(['raw']));
			messageIds.push(
				await ctx.db.insert('mailMessages', {
					mailboxId,
					folderId,
					uid: i + 1,
					modseq: i + 1,
					rfc822MessageId: `<m${i}-${now}@example.com>`,
					threadId,
					fromAddress: fromOwner.includes(i) ? OWNER : 'ada@example.com',
					toAddresses: [fromOwner.includes(i) ? 'ada@example.com' : OWNER],
					ccAddresses: [],
					bccAddresses: [],
					subject: 'Order',
					normalizedSubject: 'order',
					snippet: body.slice(0, 40),
					textBodyInline: body,
					rawStorageId,
					rawSize: 3,
					attachments: [],
					hasAttachments: false,
					flagSeen: true,
					flagFlagged: false,
					flagAnswered: false,
					flagDraft: false,
					flagDeleted: false,
					customFlags: [],
					labelIds: [],
					receivedAt: now + i,
					internalDate: now + i,
					createdAt: now,
					updatedAt: now,
				})
			);
		}
		await ctx.db.patch(threadId, { latestMessageId: messageIds[messageIds.length - 1] });
		return { threadId, messageIds };
	});
}

const THREE = [
	'Hi, could you send the September invoice?',
	'Sure, I will look for it.',
	'Thanks. Also, what is the PO number?',
];

describe('mail.ai.catchUp.ensure', () => {
	it('generates on a cold cache, maps sources, and serves the next call from the cache', async () => {
		const t = await setup();
		const { threadId, messageIds } = await seedThread(t, THREE, [1]);
		const [m1, m2, m3] = messageIds;
		modelReturns({
			sentences: [
				{ text: 'Ada asked for the September invoice.', sources: ['m1'] },
				{ text: 'You said you would look for it.', sources: ['m2'] },
				{ text: 'A sentence with an invented source.', sources: ['m9'] },
				{ text: 'A sentence with no source.', sources: [] },
			],
			asks: [
				{ text: 'Send the September invoice', source: 'm1' },
				{ text: 'Share the PO number', source: 'm3' },
				{ text: 'Something from nowhere', source: 'm42' },
			],
		});

		const card = await t.action(api.mail.ai.catchUp.ensure, { messageId: m3!, locale: 'en' });

		expect(card?.sentences).toEqual([
			{ text: 'Ada asked for the September invoice.', sourceMessageIds: [m1] },
			{ text: 'You said you would look for it.', sourceMessageIds: [m2] },
		]);
		expect(card?.asks).toEqual([
			{ id: 'ask_1', text: 'Send the September invoice', sourceMessageId: m1 },
			{ id: 'ask_2', text: 'Share the PO number', sourceMessageId: m3 },
		]);
		expect(card?.messageCount).toBe(3);
		expect(card?.locale).toBe('en');

		const call = runLlmObjectMock.mock.calls[0]![0];
		expect(call.prompt).toContain('untrusted DATA');
		expect(call.prompt).toContain('<untrusted_email_content>');
		expect(call.prompt).toContain('[m1] From: ada@example.com — the other party');
		expect(call.prompt).toContain('[m2] From: me@example.com — the mailbox owner (you)');
		expect(call.prompt).toContain('2 to 4 short sentences');

		const rows = await t.run((ctx) => ctx.db.query('threadCatchUps').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ mailThreadId: threadId, locale: 'en', mode: 'full' });

		const again = await t.action(api.mail.ai.catchUp.ensure, { messageId: m1!, locale: 'en' });
		expect(again).toEqual(card);
		expect(runLlmObjectMock).toHaveBeenCalledTimes(1);
		expect(await t.query(api.mail.ai.catchUpStore.get, { messageId: m2!, locale: 'en' })).toEqual(
			card
		);
	});

	it('treats a changed message count as stale and regenerates in place', async () => {
		const t = await setup();
		const { threadId, messageIds } = await seedThread(t, THREE);
		modelReturns({ sentences: [{ text: 'First.', sources: ['m1'] }], asks: [] });
		await t.action(api.mail.ai.catchUp.ensure, { messageId: messageIds[0]!, locale: 'en' });

		await t.run((ctx) => ctx.db.patch(threadId, { messageCount: 4 }));
		expect(
			await t.query(api.mail.ai.catchUpStore.get, { messageId: messageIds[0]!, locale: 'en' })
		).toBeNull();

		modelReturns({ sentences: [{ text: 'Second.', sources: ['m3'] }], asks: [] });
		const card = await t.action(api.mail.ai.catchUp.ensure, {
			messageId: messageIds[0]!,
			locale: 'en',
		});
		expect(card?.sentences.map((s) => s.text)).toEqual(['Second.']);
		expect(card?.messageCount).toBe(4);
		expect(runLlmObjectMock).toHaveBeenCalledTimes(2);
		expect(await t.run((ctx) => ctx.db.query('threadCatchUps').collect())).toHaveLength(1);
	});

	it('caches per interface locale, reducing a region tag', async () => {
		const t = await setup();
		const { messageIds } = await seedThread(t, THREE);
		modelReturns({
			sentences: [{ text: 'Ada fragte nach der Rechnung.', sources: ['m1'] }],
			asks: [],
		});
		const card = await t.action(api.mail.ai.catchUp.ensure, {
			messageId: messageIds[2]!,
			locale: 'de-DE',
		});
		expect(card?.locale).toBe('de');
		expect(runLlmObjectMock.mock.calls[0]![0].prompt).toContain('in German');
		expect(
			await t.query(api.mail.ai.catchUpStore.get, { messageId: messageIds[2]!, locale: 'en' })
		).toBeNull();
		expect(
			await t.query(api.mail.ai.catchUpStore.get, { messageId: messageIds[2]!, locale: 'de' })
		).toEqual(card);
	});

	it('asks a short thread for its asks only, and shows it only with two or more', async () => {
		const t = await setup();
		const { messageIds } = await seedThread(t, ['Can you send the contract?']);
		modelReturns({ sentences: [], asks: [{ text: 'Send the contract', source: 'm1' }] });

		const card = await t.action(api.mail.ai.catchUp.ensure, {
			messageId: messageIds[0]!,
			locale: 'en',
		});
		expect(card).toBeNull();
		expect(runLlmObjectMock.mock.calls[0]![0].prompt).toContain('sentences: return an empty list');
		// The asks-only result is cached too: no second model call.
		expect(
			await t.action(api.mail.ai.catchUp.ensure, { messageId: messageIds[0]!, locale: 'en' })
		).toBeNull();
		expect(runLlmObjectMock).toHaveBeenCalledTimes(1);
		const rows = await t.run((ctx) => ctx.db.query('threadCatchUps').collect());
		expect(rows[0]).toMatchObject({ mode: 'asksOnly', sentences: [] });
	});

	it('shows a short thread with two asks as a checklist without sentences', async () => {
		const t = await setup();
		const { messageIds } = await seedThread(t, ['Can you send the contract and the invoice?']);
		modelReturns({
			sentences: [{ text: 'Ignored in asks-only mode.', sources: ['m1'] }],
			asks: [
				{ text: 'Send the contract', source: 'm1' },
				{ text: 'Send the invoice', source: 'm1' },
			],
		});
		const card = await t.action(api.mail.ai.catchUp.ensure, {
			messageId: messageIds[0]!,
			locale: 'en',
		});
		expect(card?.sentences).toEqual([]);
		expect(card?.asks.map((a) => a.id)).toEqual(['ask_1', 'ask_2']);
	});

	it('gives a single long message the full card', async () => {
		const t = await setup();
		const { messageIds } = await seedThread(t, ['A long letter. '.repeat(120)]);
		modelReturns({ sentences: [{ text: 'Ada wrote at length.', sources: ['m1'] }], asks: [] });
		const card = await t.action(api.mail.ai.catchUp.ensure, {
			messageId: messageIds[0]!,
			locale: 'en',
		});
		expect(card?.sentences).toHaveLength(1);
		expect(runLlmObjectMock.mock.calls[0]![0].prompt).toContain('2 to 4 short sentences');
	});

	it('skips the model for a short thread with nothing from the other party', async () => {
		const t = await setup();
		const { messageIds } = await seedThread(t, ['Just a note to self.'], [0]);
		expect(
			await t.action(api.mail.ai.catchUp.ensure, { messageId: messageIds[0]!, locale: 'en' })
		).toBeNull();
		expect(runLlmObjectMock).not.toHaveBeenCalled();
	});

	it('returns null for a caller who cannot read the mailbox, before any model call', async () => {
		const t = await setup();
		const { messageIds } = await seedThread(t, THREE);
		session.current = { userId: 'intruder', role: 'member', activeOrganizationId: 'test-org' };
		expect(
			await t.action(api.mail.ai.catchUp.ensure, { messageId: messageIds[0]!, locale: 'en' })
		).toBeNull();
		expect(
			await t.query(api.mail.ai.catchUpStore.get, { messageId: messageIds[0]!, locale: 'en' })
		).toBeNull();
		expect(
			await t.action(api.mail.ai.catchUp.coverage, {
				messageId: messageIds[0]!,
				draftText: 'Here is the invoice.',
				locale: 'en',
			})
		).toEqual({ coveredAskIds: [] });
		expect(runLlmObjectMock).not.toHaveBeenCalled();
	});

	it('returns null while the ai flag is off', async () => {
		const t = await setup([]);
		const { messageIds } = await seedThread(t, THREE);
		expect(
			await t.action(api.mail.ai.catchUp.ensure, { messageId: messageIds[0]!, locale: 'en' })
		).toBeNull();
		expect(runLlmObjectMock).not.toHaveBeenCalled();
	});

	it('fails soft on a dispatch error and caches nothing', async () => {
		const t = await setup();
		const { messageIds } = await seedThread(t, THREE);
		runLlmObjectMock.mockRejectedValueOnce(new Error('provider down'));
		expect(
			await t.action(api.mail.ai.catchUp.ensure, { messageId: messageIds[0]!, locale: 'en' })
		).toBeNull();
		expect(await t.run((ctx) => ctx.db.query('threadCatchUps').collect())).toHaveLength(0);
	});
});

describe('mail.ai.catchUp.coverage', () => {
	async function seededCard(t: Harness) {
		const { messageIds } = await seedThread(t, THREE);
		modelReturns({
			sentences: [{ text: 'Ada wants two things.', sources: ['m1', 'm3'] }],
			asks: [
				{ text: 'Send the September invoice', source: 'm1' },
				{ text: 'Share the PO number', source: 'm3' },
			],
		});
		await t.action(api.mail.ai.catchUp.ensure, { messageId: messageIds[2]!, locale: 'en' });
		return messageIds[2]!;
	}

	it('returns the covered ask ids the card knows, in card order', async () => {
		const t = await setup();
		const messageId = await seededCard(t);
		modelReturns({ coveredAskIds: ['ask_2', 'ask_7', 'ask_2'] });
		const result = await t.action(api.mail.ai.catchUp.coverage, {
			messageId,
			draftText: 'The PO number is 4711.',
			locale: 'en',
		});
		expect(result).toEqual({ coveredAskIds: ['ask_2'] });
		const call = runLlmObjectMock.mock.calls[1]![0];
		expect(call.prompt).toContain('ask_1: Send the September invoice');
		expect(call.prompt).toContain('<draft>\nThe PO number is 4711.');
	});

	it('does not call the model for an empty draft or a thread without a card', async () => {
		const t = await setup();
		const messageId = await seededCard(t);
		expect(
			await t.action(api.mail.ai.catchUp.coverage, { messageId, draftText: '  ', locale: 'en' })
		).toEqual({ coveredAskIds: [] });
		expect(
			await t.action(api.mail.ai.catchUp.coverage, { messageId, draftText: 'Hi', locale: 'de' })
		).toEqual({ coveredAskIds: [] });
		expect(runLlmObjectMock).toHaveBeenCalledTimes(1);
	});

	it('leaves the asks unticked when the model fails', async () => {
		const t = await setup();
		const messageId = await seededCard(t);
		runLlmObjectMock.mockRejectedValueOnce(new Error('timeout'));
		expect(
			await t.action(api.mail.ai.catchUp.coverage, { messageId, draftText: 'Hi', locale: 'en' })
		).toEqual({ coveredAskIds: [] });
	});
});

describe('threadCatchUps lifetime', () => {
	it('goes with its thread when the last message is purged', async () => {
		const t = await setup();
		const { threadId, messageIds } = await seedThread(t, THREE);
		modelReturns({ sentences: [{ text: 'Soon gone.', sources: ['m1'] }], asks: [] });
		await t.action(api.mail.ai.catchUp.ensure, { messageId: messageIds[0]!, locale: 'en' });
		expect(await t.run((ctx) => ctx.db.query('threadCatchUps').collect())).toHaveLength(1);

		await t.run(async (ctx) => {
			for (const id of messageIds) await ctx.db.delete(id);
			await rebuildThreadAggregates(ctx, threadId);
		});
		expect(await t.run((ctx) => ctx.db.get(threadId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.query('threadCatchUps').collect())).toHaveLength(0);
	});
});
