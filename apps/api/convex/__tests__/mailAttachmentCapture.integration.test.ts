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
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { ATTACHMENT_COMPOSE_LIMITS } from '@owlat/shared/attachments';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { captureAttachments } from '../mail/deliveryPipeline/capture';
import {
	inboundAttachmentCandidates,
	NOTHING_UNCLEARED,
} from '../mail/deliveryPipeline/attachmentParts';
import { readScanRequest } from '../mail/__tests__/scannerStub.testlib';

const modules = import.meta.glob('../**/*.*s');

/**
 * ClamAV, answering clean.
 *
 * The delivery path indexes what the malware scan CLEARED, and the test
 * environment ships a configured MTA (`vitest.setup.ts`), so without a stub
 * every leaf comes back `'skipped'` — the scanner unreachable. Stubbing it is
 * what puts these cases on the branch a real delivery takes.
 *
 * What the mailbox route does when NOBODY answered is its own case below
 * ("keeps indexing on a deployment with no ClamAV sidecar"): the personal
 * mailbox falls back to the message's own leaves, because it is the owner's own
 * mail and switching the file library off on every no-ClamAV deployment is not
 * a change this route makes on the way past.
 */
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
	originalFetch = globalThis.fetch;
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (!url.includes('/scan/attachment')) throw new Error(`unexpected fetch: ${url}`);
		return new Response(JSON.stringify({ clean: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

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

/** The same message, with an installer the MTA's type gate refuses beside it. */
function buildRawEmlWithInstaller(): string {
	const boundary = 'b0undary';
	return buildRawEml().replace(
		`--${boundary}--`,
		[
			`--${boundary}`,
			'Content-Type: application/octet-stream; name="setup.msi"',
			'Content-Disposition: attachment; filename="setup.msi"',
			'Content-Transfer-Encoding: base64',
			'',
			Buffer.from('installer').toString('base64'),
			'',
			`--${boundary}--`,
		].join('\r\n')
	);
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

	it('captures nothing out of a message the scanner called infected', async () => {
		const t = setupTest();
		await seedInbox(t);
		globalThis.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ clean: false, virus: 'Eicar-Test-Signature' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
		) as unknown as typeof globalThis.fetch;

		await t.action(internal.mail.delivery.ingestFromWebhook, {
			deliveryId: 'd-infected',
			rawBytesBase64: Buffer.from(buildRawEml(), 'latin1').toString('base64'),
			recipientAddress: 'alice@example.com',
			from: 'Bob <bob@example.com>',
			to: ['alice@example.com'],
			cc: [],
			bcc: [],
			subject: 'with attachment',
			textBody: 'See the attached notes.',
			messageId: '<cap-infected@example.com>',
			attachments: [{ filename: 'notes.txt', contentType: 'text/plain', size: 42, partIndex: '0' }],
		});

		// The message is delivered (to Spam) and its `.eml` is kept for an
		// operator — but nothing out of it reaches summarise, embed or the
		// knowledge graph. This route used to capture from it regardless: the
		// verdict routed the MESSAGE and nothing gated the FILES.
		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(0);
	});

	it('keeps indexing on a deployment with no ClamAV sidecar', async () => {
		const t = setupTest();
		await seedInbox(t);
		// `/scan/attachment` FAILS OPEN. The `clamav` compose profile is optional
		// (`scan.attachments`), and with it absent every leaf answers exactly
		// this: a defined verdict, cleared nothing. Reading "was anything
		// scanned?" off the verdict therefore turned the personal mailbox's file
		// library off on every such deployment, silently, with nothing in the UI
		// or the log to say why.
		globalThis.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ clean: true, skipped: true, reason: 'ClamAV unavailable' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
		) as unknown as typeof globalThis.fetch;

		await t.action(internal.mail.delivery.ingestFromWebhook, {
			deliveryId: 'd-no-clamav',
			rawBytesBase64: Buffer.from(buildRawEml(), 'latin1').toString('base64'),
			recipientAddress: 'alice@example.com',
			from: 'Bob <bob@example.com>',
			to: ['alice@example.com'],
			cc: [],
			bcc: [],
			subject: 'with attachment',
			textBody: 'See the attached notes.',
			messageId: '<cap-no-clamav@example.com>',
			attachments: [{ filename: 'notes.txt', contentType: 'text/plain', size: 42, partIndex: '0' }],
		});

		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files.map((f) => f.filename)).toEqual(['notes.txt']);
	});

	it('keeps indexing the readable leaf when a type refusal rides along', async () => {
		const t = setupTest();
		await seedInbox(t);
		// Same no-ClamAV deployment, plus one leaf the MTA's file-type gate
		// refuses. That gate runs BEFORE ClamAV and answers even with no sidecar,
		// so counting it as "a scanner answered" took the whole message off the
		// fallback branch: `notes.txt` — indexed when sent alone, on this very
		// deployment — silently was not, for no reason a reader could see.
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const { filename } = readScanRequest(input, init);
			const body = filename.endsWith('.msi')
				? { clean: false, reason: 'Dangerous file type detected', stage: 'file_type_validation' }
				: { clean: true, skipped: true, reason: 'ClamAV unavailable' };
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}) as unknown as typeof globalThis.fetch;

		await t.action(internal.mail.delivery.ingestFromWebhook, {
			deliveryId: 'd-refused-beside',
			rawBytesBase64: Buffer.from(buildRawEmlWithInstaller(), 'latin1').toString('base64'),
			recipientAddress: 'alice@example.com',
			from: 'Bob <bob@example.com>',
			to: ['alice@example.com'],
			cc: [],
			bcc: [],
			subject: 'with attachment',
			textBody: 'See the attached notes.',
			messageId: '<cap-refused-beside@example.com>',
			attachments: [
				{ filename: 'notes.txt', contentType: 'text/plain', size: 42, partIndex: '0' },
				{ filename: 'setup.msi', contentType: 'application/octet-stream', size: 9, partIndex: '1' },
			],
		});

		// The document is in the library; the installer nobody scanned is not.
		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files.map((f) => f.filename)).toEqual(['notes.txt']);
	});

	it('captures a DMARC fail a trusted ARC forwarder rescued', async () => {
		const t = setupTest();
		await seedInbox(t);
		// Forwarded mail: the forwarder's footer broke the author's DKIM, so
		// DMARC evaluates `fail` — and the trusted forwarder's valid seal
		// attests the ORIGINAL passed. `resolveDmarcRouting` honours that and
		// puts the message in the Inbox; the capture gate has to honour the same
		// verdict, or the router and the gate give two answers to one question
		// and a forwarded invoice is silently never read.
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				trustedArcForwarders: ['forwarder.example'],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.action(internal.mail.delivery.ingestFromWebhook, {
			deliveryId: 'd-arc',
			rawBytesBase64: Buffer.from(buildRawEml(), 'latin1').toString('base64'),
			recipientAddress: 'alice@example.com',
			from: 'Bob <bob@example.com>',
			to: ['alice@example.com'],
			cc: [],
			bcc: [],
			subject: 'with attachment',
			textBody: 'See the attached notes.',
			messageId: '<cap-arc@example.com>',
			attachments: [{ filename: 'notes.txt', contentType: 'text/plain', size: 42, partIndex: '0' }],
			dmarcResult: 'fail',
			dmarcPolicy: 'none',
			arcCv: 'pass',
			arcSealerDomain: 'forwarder.example',
			arcAttestsOriginalPass: true,
		});

		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files.map((f) => f.filename)).toEqual(['notes.txt']);
	});

	it('captures nothing from a DMARC fail NO forwarder vouched for', async () => {
		const t = setupTest();
		await seedInbox(t);

		await t.action(internal.mail.delivery.ingestFromWebhook, {
			deliveryId: 'd-unrescued',
			rawBytesBase64: Buffer.from(buildRawEml(), 'latin1').toString('base64'),
			recipientAddress: 'alice@example.com',
			from: 'Bob <bob@example.com>',
			to: ['alice@example.com'],
			cc: [],
			bcc: [],
			subject: 'with attachment',
			textBody: 'See the attached notes.',
			messageId: '<cap-unrescued@example.com>',
			attachments: [{ filename: 'notes.txt', contentType: 'text/plain', size: 42, partIndex: '0' }],
			dmarcResult: 'fail',
			dmarcPolicy: 'none',
		});

		// The rescue is what makes the difference, not the mere presence of a
		// `fail`: a spoofed sender still files nothing anywhere.
		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(0);
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
						getFunctionName(internal.knowledge.attachmentIngestBudget.consumeAttachmentIngestBudget)
					) {
						return await t.mutation(
							internal.knowledge.attachmentIngestBudget.consumeAttachmentIngestBudget,
							args as { senderKey: string; count: number }
						);
					}
					ingested.push(args);
					return null;
				}) as unknown as ActionCtx['runMutation'],
			},
			{
				// The leaves a scan would have cleared — capture never walks the
				// MIME itself, so the test supplies the same set the scanner hands
				// it in production.
				parts: inboundAttachmentCandidates(raw),
				withheld: NOTHING_UNCLEARED,
				messageId: '<many-1@example.com>',
				from: 'Bob <bob@example.com>',
				captureSource: 'mailbox',
				auth: {},
			}
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
