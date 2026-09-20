/**
 * `captureAttachments` — who a captured file is scoped to, and which parts are
 * eligible to be captured at all.
 *
 * Proven here:
 *   · a sender with an existing contact scopes the file to that contact;
 *   · a soft-deleted (GDPR-erased) contact reads as absent, so the file is
 *     written org-general and the message is still captured — an unknown sender
 *     is never a reason to drop anything;
 *   · an unparseable From header lands org-general too;
 *   · a `From:` whose DMARC verdict is a FAIL is not indexed AT ALL — neither
 *     under the contact it claims to be nor org-general, which is the widest
 *     scope the retrieval seam has rather than the safe one;
 *   · the capturing route is recorded on the row, because that is the only
 *     thing keeping the shared-inbox retention sweep off Postbox captures;
 *   · a part over `MAX_AI_INGEST_ATTACHMENT_BYTES` is not indexed while a
 *     sibling under it in the same .eml is;
 *   · the `ATTACHMENT_COMPOSE_LIMITS.maxCount` cap still holds, and a message
 *     past it comes back marked rather than silently truncated.
 *
 * The last two drive `captureAttachments` with a ctx whose `storage.store` and
 * `semanticFiles.ingest` are counted rather than executed: convex-test
 * mis-tracks transaction state across an action's sub-operations, so a second
 * `ctx.storage.store` inside one action throws "Write outside of transaction"
 * (still the case in 0.0.55). The AI-ingest budget charge and the contact
 * lookup run for real against the live components in every case.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { getFunctionName, type FunctionReference } from 'convex/server';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import {
	ATTACHMENT_COMPOSE_LIMITS,
	MAX_AI_INGEST_ATTACHMENT_BYTES,
} from '@owlat/shared/attachments';
import { captureAttachments } from '../deliveryPipeline/capture';
import {
	inboundAttachmentCandidates,
	NOTHING_UNCLEARED,
	type UnclearedLeaves,
} from '../deliveryPipeline/attachmentParts';
import type { AttachmentCaptureOutcome, InboundFromAuth } from '../deliveryPipeline/capture';

const modules = import.meta.glob('../../**/*.*s');

function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

type IngestArgs = {
	filename: string;
	fileSize: number;
	contactIds?: Id<'contacts'>[];
	captureSource?: 'team_inbox' | 'mailbox';
};

/** Build a multipart/mixed message whose leaves are the given text bodies. */
function buildEml(messageId: string, leaves: Array<{ name: string; body: string }>): string {
	const boundary = 'scope-b0undary';
	const lines = [
		'From: Bob <bob@example.com>',
		'To: inbox@example.com',
		`Subject: ${messageId}`,
		`Message-ID: <${messageId}>`,
		`Content-Type: multipart/mixed; boundary="${boundary}"`,
		'',
		`--${boundary}`,
		'Content-Type: text/plain; charset=utf-8',
		'',
		'Body text.',
		'',
	];
	for (const leaf of leaves) {
		lines.push(
			`--${boundary}`,
			`Content-Type: text/plain; name="${leaf.name}"`,
			`Content-Disposition: attachment; filename="${leaf.name}"`,
			'Content-Transfer-Encoding: base64',
			'',
			Buffer.from(leaf.body).toString('base64'),
			''
		);
	}
	lines.push(`--${boundary}--`, '');
	return lines.join('\r\n');
}

/**
 * Drive `captureAttachments` with a counting ctx. The contact lookup and the
 * AI-ingest budget are real; only the blob store and the `semanticFiles.ingest`
 * call are recorded.
 */
async function capture(
	t: ReturnType<typeof setupTest>,
	raw: string,
	messageId: string,
	fromRaw: string,
	opts: {
		captureSource?: 'team_inbox' | 'mailbox';
		auth?: InboundFromAuth;
		withheld?: Partial<UnclearedLeaves>;
	} = {}
): Promise<{
	stored: number;
	ingested: IngestArgs[];
	skippedReason?: AttachmentCaptureOutcome['skippedReason'];
}> {
	let stored = 0;
	const ingested: IngestArgs[] = [];
	const outcome = await captureAttachments(
		{
			storage: {
				store: async () => `storage-${stored++}` as Id<'_storage'>,
			},
			runQuery: (async (ref: unknown, args: unknown) =>
				await t.query(
					ref as FunctionReference<'query', 'internal'>,
					args as Record<string, unknown>
				)) as unknown as ActionCtx['runQuery'],
			runMutation: (async (ref: unknown, args: unknown) => {
				if (
					getFunctionName(ref as FunctionReference<'mutation'>) ===
					getFunctionName(internal.semanticFiles.ingest)
				) {
					ingested.push(args as IngestArgs);
					return null;
				}
				return await t.mutation(
					ref as FunctionReference<'mutation', 'internal'>,
					args as Record<string, unknown>
				);
			}) as unknown as ActionCtx['runMutation'],
		},
		{
			// What a scan would have CLEARED. Capture no longer walks the MIME
			// itself — the parts arrive from `scanInboundAttachments` — so the
			// suite hands it the same selection the scanner would.
			parts: inboundAttachmentCandidates(raw),
			withheld: { ...NOTHING_UNCLEARED, ...opts.withheld },
			messageId,
			from: fromRaw,
			captureSource: opts.captureSource ?? 'team_inbox',
			auth: opts.auth ?? {},
		}
	);
	return { stored, ingested, skippedReason: outcome.skippedReason };
}

async function seedContact(
	t: ReturnType<typeof setupTest>,
	email: string,
	options: { deleted?: boolean } = {}
): Promise<Id<'contacts'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('contacts', {
			email,
			source: 'inbound',
			doiStatus: 'not_required',
			searchableText: email,
			createdAt: now,
			updatedAt: now,
			...(options.deleted ? { deletedAt: now } : {}),
		});
	});
}

describe('captureAttachments — contact scoping', () => {
	it('scopes a captured file to the sender contact when one exists', async () => {
		const t = setupTest();
		const contactId = await seedContact(t, 'bob@example.com');

		const { ingested } = await capture(
			t,
			buildEml('scope-1@example.com', [{ name: 'notes.txt', body: 'a real document' }]),
			'<scope-1@example.com>',
			'Bob <bob@example.com>'
		);

		expect(ingested).toHaveLength(1);
		expect(ingested[0]!.contactIds).toEqual([contactId]);
	});

	it('falls back to org-general when the sender contact was erased', async () => {
		const t = setupTest();
		// A soft-deleted contact is a gravestone: `getByEmailForTeam` filters it
		// out, so the sender reads as unknown — and unknown must still capture.
		await seedContact(t, 'bob@example.com', { deleted: true });

		const { ingested } = await capture(
			t,
			buildEml('scope-2@example.com', [{ name: 'notes.txt', body: 'a real document' }]),
			'<scope-2@example.com>',
			'Bob <bob@example.com>'
		);

		expect(ingested).toHaveLength(1);
		expect(ingested[0]!.contactIds).toBeUndefined();
	});

	it('indexes NOTHING when DMARC failed the From header', async () => {
		const t = setupTest();
		// The contact is real; the message claiming to be from them is not. A
		// `From:` header is free text, and DMARC is the check that binds it to a
		// domain that authorized the send.
		//
		// There is no safe scope for this file. Under the claimed contact it
		// joins that customer's retrieval, where the agent drafting their reply
		// picks it up; ORG-GENERAL is worse, not better — an org-general file
		// matches EVERY contact scope the retrieval seam has, so filing it there
		// hands a spoofed sender's document to every conversation in the
		// instance. So it is not indexed at all.
		await seedContact(t, 'ceo@customer.example');

		const { stored, ingested, skippedReason } = await capture(
			t,
			buildEml('spoof-1@example.com', [{ name: 'instructions.txt', body: 'do this instead' }]),
			'<spoof-1@example.com>',
			'CEO <ceo@customer.example>',
			{ auth: { dmarcResult: 'fail' } }
		);

		// Not dropped — the message, its metadata and its downloadable `.eml`
		// all still exist — but no blob was staged and nothing reached a model.
		expect(ingested).toHaveLength(0);
		expect(stored).toBe(0);
		expect(skippedReason).toBe('unverified');
	});

	it('still scopes when DMARC passed, or when the MTA asserted no verdict', async () => {
		const t = setupTest();
		const contactId = await seedContact(t, 'bob@example.com');

		const verified: InboundFromAuth[] = [
			{ dmarcResult: 'pass' },
			// No published policy, but DKIM passed on the From domain itself —
			// which is the check DMARC would have made.
			{ dmarcResult: 'none', dkimResult: 'pass', dkimSigningDomain: 'example.com' },
			// No published policy, and SPF passed on an aligned envelope domain.
			{ dmarcResult: 'none', spfResult: 'pass', envelopeFromDomain: 'mail.example.com' },
			// An MTA too old to compute any of this asserts nothing, which is not
			// a failure — it is how every message before the verdicts existed
			// arrives.
			{},
		];
		for (const [index, auth] of verified.entries()) {
			const { ingested } = await capture(
				t,
				buildEml(`dmarc-${index}@example.com`, [{ name: 'notes.txt', body: 'a document' }]),
				`<dmarc-${index}@example.com>`,
				'Bob <bob@example.com>',
				{ auth }
			);
			expect(ingested[0]!.contactIds).toEqual([contactId]);
		}
	});

	it('indexes nothing for a DMARC verdict that established nothing', async () => {
		const t = setupTest();
		await seedContact(t, 'ceo@customer.example');

		// Every one of these used to file the document under the claimed
		// contact, because the refusal matched the `'fail'` LITERAL: a transient
		// DNS failure at the MTA (`temperror`), a broken record (`permerror`),
		// and a domain with no policy at all whose only authentication passes
		// belong to the ATTACKER'S domain rather than the From domain.
		const unverified: InboundFromAuth[] = [
			{ dmarcResult: 'temperror' },
			{ dmarcResult: 'permerror' },
			{ dmarcResult: 'none' },
			{
				dmarcResult: 'none',
				dkimResult: 'pass',
				dkimSigningDomain: 'attacker.example',
				spfResult: 'pass',
				envelopeFromDomain: 'attacker.example',
			},
		];
		for (const [index, auth] of unverified.entries()) {
			const { stored, ingested, skippedReason } = await capture(
				t,
				buildEml(`unverified-${index}@example.com`, [{ name: 'notes.txt', body: 'a doc' }]),
				`<unverified-${index}@example.com>`,
				'CEO <ceo@customer.example>',
				{ auth }
			);
			expect(ingested).toHaveLength(0);
			expect(stored).toBe(0);
			expect(skippedReason).toBe('unverified');
		}
	});

	it('falls back to org-general when the From header has no address in it', async () => {
		const t = setupTest();

		const { ingested } = await capture(
			t,
			buildEml('scope-3@example.com', [{ name: 'notes.txt', body: 'a real document' }]),
			'<scope-3@example.com>',
			'not an address at all'
		);

		expect(ingested).toHaveLength(1);
		expect(ingested[0]!.contactIds).toBeUndefined();
	});
});

describe('captureAttachments — eligibility ceilings', () => {
	it('skips a part over the AI-ingest ceiling while capturing its sibling under it', async () => {
		const t = setupTest();
		const oversized = 'x'.repeat(MAX_AI_INGEST_ATTACHMENT_BYTES + 1);

		const { ingested } = await capture(
			t,
			buildEml('ceiling-1@example.com', [
				{ name: 'huge.txt', body: oversized },
				{ name: 'small.txt', body: 'under the ceiling' },
			]),
			'<ceiling-1@example.com>',
			'Bob <bob@example.com>'
		);

		expect(ingested.map((f) => f.filename)).toEqual(['small.txt']);
		// The big part is not dropped from the message — it is only not indexed.
		// Its bytes stay in the raw .eml the reader downloads from.
		expect(ingested[0]!.fileSize).toBeLessThanOrEqual(MAX_AI_INGEST_ATTACHMENT_BYTES);
	});

	it('records which route captured the file, so the sweep can tell them apart', async () => {
		const t = setupTest();

		const team = await capture(
			t,
			buildEml('src-1@example.com', [{ name: 'a.txt', body: 'a document' }]),
			'<src-1@example.com>',
			'Bob <bob@example.com>',
			{ captureSource: 'team_inbox' }
		);
		const mailbox = await capture(
			t,
			buildEml('src-2@example.com', [{ name: 'b.txt', body: 'a document' }]),
			'<src-2@example.com>',
			'Bob <bob@example.com>',
			{ captureSource: 'mailbox' }
		);

		// Both write `sourceType: 'email_attachment'`; only this distinguishes
		// them, and the inbound retention sweep scans `team_inbox` alone.
		expect(team.ingested[0]!.captureSource).toBe('team_inbox');
		expect(mailbox.ingested[0]!.captureSource).toBe('mailbox');
	});

	it('captures at most the per-message part cap, and SAYS the rest were left', async () => {
		const t = setupTest();
		const leafCount = ATTACHMENT_COMPOSE_LIMITS.maxCount + 2;
		const leaves = Array.from({ length: leafCount }, (_, i) => ({
			name: `doc-${i}.txt`,
			body: `document number ${i}`,
		}));

		const { stored, ingested, skippedReason } = await capture(
			t,
			buildEml('cap-1@example.com', leaves),
			'<cap-1@example.com>',
			'Bob <bob@example.com>'
		);

		expect(stored).toBe(ATTACHMENT_COMPOSE_LIMITS.maxCount);
		expect(ingested).toHaveLength(ATTACHMENT_COMPOSE_LIMITS.maxCount);
		// The two files past the cap are stored, listed and downloadable and the
		// assistant has never seen them. Without this the row reads `indexed`
		// and the reader is shown twelve rows that all look read.
		expect(skippedReason).toBe('cap');
	});

	it('reports the cap when the SCAN is what withheld the rest', async () => {
		const t = setupTest();
		// The scanner opens at most `maxCount` leaves and hands over only what it
		// cleared; anything past that never reaches capture at all. Capture still
		// has to report it, because the reader's line is about the message, not
		// about which component stopped looking.
		const { ingested, skippedReason } = await capture(
			t,
			buildEml('cap-2@example.com', [{ name: 'doc.txt', body: 'a document' }]),
			'<cap-2@example.com>',
			'Bob <bob@example.com>',
			{ withheld: { capped: 3 } }
		);

		expect(ingested).toHaveLength(1);
		expect(skippedReason).toBe('cap');
	});

	it('reports a scanner outage as unscanned, not as the cap', async () => {
		const t = setupTest();
		// Two files, ClamAV answered for one of them. The message is nowhere
		// near the ten-leaf cap, so "this message has more attachments than it
		// processes" would send an operator to the wrong place entirely — the
		// thing to fix is the scanner.
		const { ingested, skippedReason } = await capture(
			t,
			buildEml('partial-scan@example.com', [{ name: 'doc.txt', body: 'a document' }]),
			'<partial-scan@example.com>',
			'Bob <bob@example.com>',
			{ withheld: { unscanned: 1 } }
		);

		expect(ingested).toHaveLength(1);
		expect(skippedReason).toBe('unscanned');
	});

	it('outranks the cap with the outage when both happened', async () => {
		const t = setupTest();
		const { skippedReason } = await capture(
			t,
			buildEml('both@example.com', [{ name: 'doc.txt', body: 'a document' }]),
			'<both@example.com>',
			'Bob <bob@example.com>',
			{ withheld: { capped: 2, unscanned: 1 } }
		);

		// One line is rendered, and the outage is the one that sends someone
		// somewhere useful.
		expect(skippedReason).toBe('unscanned');
	});

	it("reports the scanner's file-type refusal as an unsupported type", async () => {
		const t = setupTest();
		const { ingested, skippedReason } = await capture(
			t,
			buildEml('refused@example.com', [{ name: 'doc.txt', body: 'a document' }]),
			'<refused@example.com>',
			'Bob <bob@example.com>',
			{ withheld: { refusedType: 1 } }
		);

		// The scan ANSWERED about that leaf — it is a type the endpoint will not
		// pass, not malware and not an outage.
		expect(ingested).toHaveLength(1);
		expect(skippedReason).toBe('unsupported_type');
	});

	it('never indexes an inline leaf, and never calls it a skip', async () => {
		const t = setupTest();
		// The scan clears inline leaves too — everything the reader can download
		// is scanned — but an embedded signature logo is not a document anyone
		// attached, so it is dropped here. Silently: a "the assistant has not
		// read these" line on every message with a logo in the footer is how a
		// warning stops being read.
		const raw = [
			'From: Bob <bob@example.com>',
			'To: team@example.com',
			'Subject: with a logo',
			'Message-ID: <inline-capture@example.com>',
			'MIME-Version: 1.0',
			'Content-Type: multipart/mixed; boundary="B"',
			'',
			'--B',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'regards',
			'--B',
			'Content-Type: image/png; name="logo.png"',
			'Content-Disposition: inline; filename="logo.png"',
			'',
			'pretend png bytes',
			'--B--',
			'',
		].join('\r\n');

		const { stored, ingested, skippedReason } = await capture(
			t,
			raw,
			'<inline-capture@example.com>',
			'Bob <bob@example.com>'
		);

		expect(ingested).toHaveLength(0);
		expect(stored).toBe(0);
		expect(skippedReason).toBeUndefined();
	});
});
