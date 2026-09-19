/**
 * Inbound email-attachment capture into the semantic file library.
 *
 * Closes the gap where inbound attachments were parsed onto the `mailMessages`
 * row but never persisted as `semanticFiles`, so the "Email attachments" source
 * filter on /dashboard/files always showed nothing. `mail.delivery.ingestFromWebhook`
 * now pulls attachment leaves out of the raw .eml and ingests each via
 * `semanticFiles.ingest`. This drives that action end-to-end.
 */

import { convexTest } from 'convex-test';
import { getFunctionName, type FunctionReference } from 'convex/server';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { ATTACHMENT_COMPOSE_LIMITS } from '@owlat/shared/attachments';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { captureAttachments } from '../mail/deliveryPipeline/ingest';

const modules = import.meta.glob('../**/*.*s');

/**
 * Attachment capture charges the per-sender/global AI-ingest budget before it
 * ingests anything, and the limiter writes real component state, so the
 * component has to be live or every capture reads as "budget unavailable".
 */
function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

async function seedInbox(t: ReturnType<typeof convexTest>): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'test-user',
			organizationId: 'test-org',
			address: 'alice@example.com',
			domain: 'example.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('mailFolders', {
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
	});
}

/** A multipart message with a plain body + one .txt attachment + one inline image. */
function buildRawEml(): string {
	const boundary = 'b0undary';
	const attachmentB64 = Buffer.from('hello from the attachment, a real document').toString(
		'base64'
	);
	const imageB64 = Buffer.from('\x89PNG fake').toString('base64');
	return [
		'From: Bob <bob@example.com>',
		'To: alice@example.com',
		'Subject: with attachment',
		'Message-ID: <cap-1@example.com>',
		`Content-Type: multipart/mixed; boundary="${boundary}"`,
		'',
		`--${boundary}`,
		'Content-Type: text/plain; charset=utf-8',
		'',
		'See the attached notes.',
		'',
		`--${boundary}`,
		'Content-Type: text/plain; name="notes.txt"',
		'Content-Disposition: attachment; filename="notes.txt"',
		'Content-Transfer-Encoding: base64',
		'',
		attachmentB64,
		'',
		`--${boundary}`,
		'Content-Type: image/png; name="logo.png"',
		'Content-Disposition: inline; filename="logo.png"',
		'Content-Transfer-Encoding: base64',
		'',
		imageB64,
		'',
		`--${boundary}--`,
		'',
	].join('\r\n');
}

describe('mail.delivery.ingestFromWebhook — attachment capture', () => {
	it('persists a delivered attachment as an email_attachment semantic file', async () => {
		const t = setupTest();
		await seedInbox(t);

		const raw = buildRawEml();
		const result = await t.action(internal.mail.delivery.ingestFromWebhook, {
			deliveryId: 'd1',
			rawBytesBase64: Buffer.from(raw, 'latin1').toString('base64'),
			recipientAddress: 'alice@example.com',
			from: 'Bob <bob@example.com>',
			to: ['alice@example.com'],
			cc: [],
			bcc: [],
			subject: 'with attachment',
			textBody: 'See the attached notes.',
			messageId: '<cap-1@example.com>',
			attachments: [{ filename: 'notes.txt', contentType: 'text/plain', size: 42, partIndex: '0' }],
		});
		expect('messageId' in result).toBe(true);

		// The .txt attachment was captured into the file library; the inline image
		// (disposition: inline) was skipped.
		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(1);
		const file = files[0]!;
		expect(file.sourceType).toBe('email_attachment');
		expect(file.filename).toBe('notes.txt');
		expect(file.sourceMessageId).toBe('<cap-1@example.com>');
		expect(file.fileSize).toBeGreaterThan(0);

		// The captured bytes round-trip through storage. A freshly captured file
		// always has a blob — `storageId` is only absent once the retention sweep
		// has released it.
		const storageId = file.storageId;
		expect(storageId).toBeDefined();
		const text = await t.run(async (ctx) => {
			const blob = storageId ? await ctx.storage.get(storageId) : null;
			return blob ? blob.text() : null;
		});
		expect(text).toContain('a real document');
	});

	it('captures nothing when the message has no real attachments', async () => {
		const t = setupTest();
		await seedInbox(t);

		const raw = [
			'From: Bob <bob@example.com>',
			'To: alice@example.com',
			'Subject: plain',
			'Message-ID: <plain-1@example.com>',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Just a plain message, nothing attached.',
			'',
		].join('\r\n');

		await t.action(internal.mail.delivery.ingestFromWebhook, {
			deliveryId: 'd2',
			rawBytesBase64: Buffer.from(raw, 'latin1').toString('base64'),
			recipientAddress: 'alice@example.com',
			from: 'Bob <bob@example.com>',
			to: ['alice@example.com'],
			cc: [],
			bcc: [],
			subject: 'plain',
			textBody: 'Just a plain message, nothing attached.',
			messageId: '<plain-1@example.com>',
			attachments: [],
		});

		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(0);
	});

	// convex-test mis-tracks transaction state across an action's sub-operations,
	// so a second `ctx.storage.store` inside one action throws "Write outside of
	// transaction" (still the case in 0.0.55). The cap lives in captureAttachments,
	// which takes its ctx as a parameter, so the many-leaf message is driven
	// through it with a counting ctx rather than through the action. The AI-ingest
	// budget charge still runs for real against the live limiter component — only
	// the `semanticFiles.ingest` call is counted instead of executed.
	it('caps captured attachments per message to bound LLM cost amplification', async () => {
		const boundary = 'manyb0undary';
		const leafCount = ATTACHMENT_COMPOSE_LIMITS.maxCount + 5;
		const parts: string[] = [
			'From: Bob <bob@example.com>',
			'To: alice@example.com',
			'Subject: many attachments',
			'Message-ID: <many-1@example.com>',
			`Content-Type: multipart/mixed; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: text/plain; charset=utf-8',
			'',
			'See the attached notes.',
			'',
		];
		for (let i = 0; i < leafCount; i++) {
			const b64 = Buffer.from(`document number ${i}`).toString('base64');
			parts.push(
				`--${boundary}`,
				`Content-Type: text/plain; name="doc-${i}.txt"`,
				`Content-Disposition: attachment; filename="doc-${i}.txt"`,
				'Content-Transfer-Encoding: base64',
				'',
				b64,
				''
			);
		}
		parts.push(`--${boundary}--`, '');
		const raw = parts.join('\r\n');

		const t = setupTest();
		const stored: string[] = [];
		const ingested: unknown[] = [];
		await captureAttachments(
			{
				storage: {
					store: async () => {
						const id = `storage-${stored.length}` as Id<'_storage'>;
						stored.push(id);
						return id;
					},
				},
				runQuery: (async () => null) as unknown as ActionCtx['runQuery'],
				runMutation: (async (ref: unknown, args: unknown) => {
					if (
						getFunctionName(ref as FunctionReference<'mutation'>) ===
						getFunctionName(internal.semanticFileBudget.consumeAttachmentIngestBudget)
					) {
						return await t.mutation(
							internal.semanticFileBudget.consumeAttachmentIngestBudget,
							args as { senderKey: string; count: number }
						);
					}
					ingested.push(args);
					return null;
				}) as unknown as ActionCtx['runMutation'],
			},
			raw,
			'<many-1@example.com>',
			'Bob <bob@example.com>'
		);

		expect(stored).toHaveLength(ATTACHMENT_COMPOSE_LIMITS.maxCount);
		expect(ingested).toHaveLength(ATTACHMENT_COMPOSE_LIMITS.maxCount);
	});
});

/** Seed a live email-channel contact so the sender resolves find-only. */
async function seedContact(t: ReturnType<typeof convexTest>, email: string): Promise<string> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('contacts', {
			email,
			source: 'inbound',
			doiStatus: 'not_required',
			searchableText: email,
			createdAt: now,
			updatedAt: now,
		});
	});
}

describe('mail.delivery.ingestFromWebhook — sender contact linking', () => {
	it('links a captured attachment to the sender contact when one exists', async () => {
		const t = setupTest();
		await seedInbox(t);
		const contactId = await seedContact(t, 'bob@example.com');

		const raw = buildRawEml();
		const result = await t.action(internal.mail.delivery.ingestFromWebhook, {
			deliveryId: 'link-1',
			rawBytesBase64: Buffer.from(raw, 'latin1').toString('base64'),
			recipientAddress: 'alice@example.com',
			from: 'Bob <bob@example.com>',
			to: ['alice@example.com'],
			cc: [],
			bcc: [],
			subject: 'with attachment',
			textBody: 'See the attached notes.',
			messageId: '<cap-link-1@example.com>',
			attachments: [{ filename: 'notes.txt', contentType: 'text/plain', size: 42, partIndex: '0' }],
		});
		expect('messageId' in result).toBe(true);

		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(1);
		const file = files[0]!;
		// The in-place array copy carries the sender contact.
		expect(file.contactIds).toEqual([contactId]);
		// The index-able junction (consumed by listByContact / ContactFilesTab) is
		// linked to the same contact.
		const junction = await t.run((ctx) =>
			ctx.db
				.query('semanticFileContacts')
				.withIndex('by_file', (q) => q.eq('fileId', file._id))
				.collect()
		);
		expect(junction.map((r) => r.contactId)).toEqual([contactId]);
	});

	it('leaves the captured attachment org-general when the sender is unknown', async () => {
		const t = setupTest();
		await seedInbox(t);
		// A DIFFERENT contact exists; the sender (bob@) must not resolve to it.
		await seedContact(t, 'someone-else@example.com');

		const raw = buildRawEml();
		await t.action(internal.mail.delivery.ingestFromWebhook, {
			deliveryId: 'link-2',
			rawBytesBase64: Buffer.from(raw, 'latin1').toString('base64'),
			recipientAddress: 'alice@example.com',
			from: 'Bob <bob@example.com>',
			to: ['alice@example.com'],
			cc: [],
			bcc: [],
			subject: 'with attachment',
			textBody: 'See the attached notes.',
			messageId: '<cap-link-2@example.com>',
			attachments: [{ filename: 'notes.txt', contentType: 'text/plain', size: 42, partIndex: '0' }],
		});

		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(1);
		const file = files[0]!;
		// No contact resolved → file stays org-general (today's behavior).
		expect(file.contactIds ?? []).toEqual([]);
		const junction = await t.run((ctx) =>
			ctx.db
				.query('semanticFileContacts')
				.withIndex('by_file', (q) => q.eq('fileId', file._id))
				.collect()
		);
		expect(junction).toHaveLength(0);
	});
});
