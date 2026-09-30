/**
 * A Team Inbox message larger than a Convex document is stored — and every
 * reader gets its body back.
 *
 * Before #900 a 1.5 MiB HTML newsletter was accepted by SMTP, reached
 * `receiveMessage`, and failed its insert on the 1 MiB document limit, so the
 * MTA retried it into the dead-letter queue. Now the part that does not fit is
 * a sealed blob, and these cases walk each reader class over it:
 *   · the agent pipeline and knowledge ingestion (actions): the whole body;
 *   · the thread view and the review lists (queries): plaintext inline parts
 *     and the excerpt, never an `atrest:` envelope, with the full text one
 *     authorized action away;
 *   · handling rules (a query): the excerpt when the readable part is stored;
 *   · the contact timeline mirror: a bounded projection naming the row;
 *   · the GDPR contact export: the whole body, read out of storage.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { api, internal } from '../../_generated/api';
import { enableFeatures } from '../../__tests__/factories';
import { openInboundMessageBody } from '../../lib/messageBodyInbound';
import { openUnifiedMessageContent } from '../../lib/messageBody';
import { inboundBodyForContext } from '../../agent/steps/context_retrieval/currentMessage';
import { buildPluginAgentStepInput } from '../../agent/pluginStepRuntime';
import { INBOUND_BODY_EXCERPT_CODE_POINTS } from '../bodyStorage';
import {
	MIB,
	SECRET,
	TAIL_CANARY,
	htmlOfSize,
	ingest,
	onlyRow,
	setupTest,
} from './largeBodies.testlib';

const ADMIN = { userId: 'test-user', role: 'owner' as const, activeOrganizationId: 'org' };

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: vi.fn(async () => ADMIN),
		requireOrgMember: vi.fn(async () => ADMIN),
		requireOrgPermission: vi.fn(async () => ADMIN),
	};
});

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', SECRET);
	vi.stubEnv('MTA_INTERNAL_URL', '');
	vi.stubEnv('MTA_API_URL', '');
	vi.stubEnv('MTA_API_KEY', '');
});

const TEXT_PART = 'The plain-text part of the newsletter.';

describe('a 1.5 MiB HTML newsletter with a short text part', () => {
	it('is stored: the HTML in a sealed blob, the row far under the document limit', async () => {
		const t = setupTest();
		const html = htmlOfSize(1.5 * MIB);
		expect(
			(await ingest(t, { messageId: 'news-1', textBody: TEXT_PART, htmlBody: html })).isDuplicate
		).toBe(false);

		const row = await onlyRow(t);
		expect(row.htmlBody).toBeUndefined();
		expect(row.htmlBodyStorageId).toBeDefined();
		// The text part stayed inline, sealed; it is also what a reader shows, so
		// no excerpt stands in for anything.
		expect(row.textBody?.startsWith('atrest:')).toBe(true);
		expect(row.textBodyStorageId).toBeUndefined();
		expect(row.bodyExcerpt).toBeUndefined();
		expect(JSON.stringify(row).length).toBeLessThan(64 * 1024);

		// The blob is sealed at rest: the canary is not in the stored bytes.
		const stored = await t.run(async (ctx) => {
			const blob = await ctx.storage.get(row.htmlBodyStorageId!);
			return new TextDecoder().decode(new Uint8Array(await blob!.arrayBuffer()));
		});
		expect(stored).not.toContain(TAIL_CANARY);
	});

	it('reads back whole through the action-side accessor the agent and knowledge use', async () => {
		const t = setupTest();
		const html = htmlOfSize(1.5 * MIB);
		await ingest(t, { messageId: 'news-2', textBody: TEXT_PART, htmlBody: html });
		const row = await onlyRow(t);

		const read = await t.run(async (ctx) => ({
			body: await openInboundMessageBody(row, ctx.storage),
			context: await inboundBodyForContext(row, ctx.storage),
			plugin: await buildPluginAgentStepInput(row, ctx.storage),
		}));
		expect(read.body).toEqual({ text: TEXT_PART, html, isComplete: true, excerpt: undefined });
		expect(read.context).toBe(TEXT_PART);
		// The plugin input bounds the body it hands out — from the real HTML.
		expect(read.plugin.htmlBody?.startsWith('<html><body><p>Monthly newsletter')).toBe(true);
	});

	it('the thread view gets plaintext and a storage reference, never ciphertext', async () => {
		const t = setupTest();
		await ingest(t, { messageId: 'news-3', textBody: TEXT_PART, htmlBody: htmlOfSize(1.5 * MIB) });
		const row = await onlyRow(t);

		const thread = await t.query(api.inbox.queries.getThread, { threadId: row.threadId! });
		expect(thread?.messages[0]?.textBody).toBe(TEXT_PART);
		expect(thread?.messages[0]?.htmlBodyStorageId).toBe(row.htmlBodyStorageId);
		expect(JSON.stringify(thread)).not.toContain('atrest:');

		// The query side of the one accessor says the body is not all there.
		const queryRead = await t.run(() => openInboundMessageBody(row, null));
		expect(queryRead.isComplete).toBe(false);
		expect(queryRead.text).toBe(TEXT_PART);
	});

	it('mirrors into the contact timeline as a bounded projection naming the row', async () => {
		const t = setupTest();
		await ingest(t, { messageId: 'news-4', textBody: TEXT_PART, htmlBody: htmlOfSize(1.5 * MIB) });
		const row = await onlyRow(t);

		const mirrors = await t.run((ctx) => ctx.db.query('unifiedMessages').collect());
		expect(mirrors).toHaveLength(1);
		expect(mirrors[0]!.content.length).toBeLessThan(8 * 1024);
		const content = await openUnifiedMessageContent(mirrors[0]!.content);
		expect(content).toMatchObject({
			text: TEXT_PART,
			isBodyTruncated: true,
			inboundMessageId: row._id,
		});
		expect(content.html).toBeUndefined();

		const timeline = await t.query(api.contacts.timeline.getTimeline, {
			contactId: row.contactId!,
		});
		const serialized = JSON.stringify(timeline);
		expect(serialized).not.toContain('atrest:');
		expect(serialized).not.toContain(TAIL_CANARY);
	});

	it('the contact export carries the whole HTML, read out of storage', async () => {
		const t = setupTest();
		const html = htmlOfSize(1.5 * MIB);
		await ingest(t, { messageId: 'news-5', textBody: TEXT_PART, htmlBody: html });
		const row = await onlyRow(t);

		const bundle = await t.action(api.contacts.dataExport.exportContactDataBundle, {
			contactId: row.contactId!,
		});
		const exported = bundle.inboundMessages.rows[0]!;
		expect(exported.textBody).toBe(TEXT_PART);
		expect(exported.htmlBody).toBe(html);
		expect(exported.storedBodyAvailability).toEqual({ text: undefined, html: 'available' });

		// The previous release's query cannot read storage: it says nothing
		// rather than anything sealed.
		const legacy = await t.query(api.contacts.dataExport.exportContactData, {
			contactId: row.contactId!,
		});
		expect(legacy.inboundMessages.rows[0]!.htmlBody).toBeUndefined();
		expect(JSON.stringify(legacy)).not.toContain('atrest:');
	});
});

describe('a large body whose readable part is in storage', () => {
	it('an HTML-only message leaves an excerpt that queries and handling rules read', async () => {
		const t = setupTest();
		const html = htmlOfSize(1.5 * MIB, 'Refund request for order 4711');
		await ingest(t, { messageId: 'html-only-1', htmlBody: html });
		const row = await onlyRow(t);
		expect(row.bodyExcerpt?.startsWith('atrest:')).toBe(true);

		const thread = await t.query(api.inbox.queries.getThread, { threadId: row.threadId! });
		expect(thread?.messages[0]?.bodyExcerpt?.startsWith('Refund request for order 4711')).toBe(
			true
		);
		expect(JSON.stringify(thread)).not.toContain('atrest:');

		// Enabled after the ingest so the agent pipeline never starts.
		await enableFeatures(t, ['ai.autonomy']);
		await t.run(async (ctx) => {
			await ctx.db.insert('handlingRules', {
				instruction: 'never auto-send refunds',
				isEnabled: true,
				matcher: { bodyContains: ['refund request'] },
				action: { type: 'never_auto_send' },
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		const outcome = await t.query(internal.mail.handlingRules.evaluateForMessage, {
			inboundMessageId: row._id,
		});
		expect(outcome.restrictsAutoSend).toBe(true);
	});

	it('a multibyte text part too large for the row is stored whole and served to the reader', async () => {
		const t = setupTest();
		// 300k code units, ~600 KiB of UTF-8 — the `.length` alone would pass for small.
		const text = `Grüße aus Köln. ${'Übergrößenträger '.repeat(18_000)}${TAIL_CANARY}`;
		await ingest(t, { messageId: 'text-1', textBody: text });
		const row = await onlyRow(t);
		expect(row.textBody).toBeUndefined();
		expect(row.textBodyStorageId).toBeDefined();

		const thread = await t.query(api.inbox.queries.getThread, { threadId: row.threadId! });
		const excerpt = thread?.messages[0]?.bodyExcerpt ?? '';
		expect(excerpt.startsWith('Grüße aus Köln.')).toBe(true);
		expect(Array.from(excerpt)).toHaveLength(INBOUND_BODY_EXCERPT_CODE_POINTS);
		expect(excerpt).not.toContain(TAIL_CANARY);

		// The thread view's "rest of the message" action returns all of it.
		expect(await t.action(api.inbox.bodyText.getInboundMessageText, { messageId: row._id })).toBe(
			text
		);
	});
});
