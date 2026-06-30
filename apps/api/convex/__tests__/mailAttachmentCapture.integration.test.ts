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
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { ATTACHMENT_COMPOSE_LIMITS } from '@owlat/shared/attachments';

const modules = import.meta.glob('../**/*.*s');

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
	const attachmentB64 = Buffer.from('hello from the attachment, a real document').toString('base64');
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
		const t = convexTest(schema, modules);
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
			attachments: [
				{ filename: 'notes.txt', contentType: 'text/plain', size: 42, partIndex: '0' },
			],
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

		// The captured bytes round-trip through storage.
		const text = await t.run(async (ctx) => {
			const blob = await ctx.storage.get(file.storageId);
			return blob ? blob.text() : null;
		});
		expect(text).toContain('a real document');
	});

	it('captures nothing when the message has no real attachments', async () => {
		const t = convexTest(schema, modules);
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

	it('caps captured attachments per message to bound LLM cost amplification', async () => {
		const t = convexTest(schema, modules);
		await seedInbox(t);

		// Craft a message carrying far more real attachment leaves than the cap.
		// The inbound webhook is attacker-reachable and each captured file
		// schedules summarization/embedding/knowledge LLM calls, so the count of
		// ingested files must be bounded regardless of how many leaves arrive.
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
				'',
			);
		}
		parts.push(`--${boundary}--`, '');
		const raw = parts.join('\r\n');

		await t.action(internal.mail.delivery.ingestFromWebhook, {
			deliveryId: 'd3',
			rawBytesBase64: Buffer.from(raw, 'latin1').toString('base64'),
			recipientAddress: 'alice@example.com',
			from: 'Bob <bob@example.com>',
			to: ['alice@example.com'],
			cc: [],
			bcc: [],
			subject: 'many attachments',
			textBody: 'See the attached notes.',
			messageId: '<many-1@example.com>',
			attachments: [],
		});

		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(ATTACHMENT_COMPOSE_LIMITS.maxCount);
	});
});
