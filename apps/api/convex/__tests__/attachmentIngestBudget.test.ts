/**
 * The AI-spend budget for inbound attachment ingestion.
 *
 * Inbound mail is reachable by any sender, and every captured attachment
 * schedules a summarize completion, an embedding, and — for real extracted
 * text — an extract completion plus one embedding per knowledge entry. The
 * budget is what bounds that.
 *
 * Proven here:
 *   · the per-sender bucket actually runs out, and running out is per SENDER —
 *     a different sender is unaffected;
 *   · the global bucket is charged only when the per-sender charge passed, so
 *     one sender over their cap cannot also drain the instance's;
 *   · when it trips, nothing is lost but the indexing: the message row, its
 *     attachment metadata and the sealed raw `.eml` all still exist, and no
 *     `semanticFiles` row is written.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { internal } from '../_generated/api';

const modules = import.meta.glob('../**/*.*s');

function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

/** The per-sender bucket's burst capacity, from rateLimiter.ts. */
const PER_SENDER_CAPACITY = 40;
/** The global bucket's burst capacity, from rateLimiter.ts. */
const GLOBAL_CAPACITY = 400;
/**
 * Files per charge. The real caller batches at the per-message part cap, and
 * `consumeAttachmentIngestBudget` clamps to it — the limiter THROWS rather than
 * refusing when a single charge exceeds a bucket's capacity, so the clamp is
 * what keeps a malformed count from surfacing as a logged capture failure.
 */
const BATCH = 10;

const SAVED_ENV = { ...process.env };

beforeEach(() => {
	// Fake time so the token buckets cannot quietly refill mid-test.
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	process.env = { ...SAVED_ENV };
});

describe('consumeAttachmentIngestBudget', () => {
	it('runs out for one sender and leaves a different sender unaffected', async () => {
		const t = setupTest();

		// Drain the per-sender bucket exactly, one file at a time.
		for (let i = 0; i < PER_SENDER_CAPACITY; i++) {
			const res = await t.mutation(internal.semanticFileBudget.consumeAttachmentIngestBudget, {
				senderKey: 'flooder@example.com',
				count: 1,
			});
			expect(res.ok).toBe(true);
		}

		const overCap = await t.mutation(internal.semanticFileBudget.consumeAttachmentIngestBudget, {
			senderKey: 'flooder@example.com',
			count: 1,
		});
		expect(overCap.ok).toBe(false);

		// Per-SENDER, not per-instance: the next sender still gets their budget.
		const other = await t.mutation(internal.semanticFileBudget.consumeAttachmentIngestBudget, {
			senderKey: 'someone-else@example.com',
			count: 1,
		});
		expect(other.ok).toBe(true);
	});

	it('does not charge the global bucket when the per-sender charge failed', async () => {
		const t = setupTest();

		// Drain one sender's bucket, then keep asking. Every further attempt from
		// that sender is refused BEFORE the global bucket is touched.
		await t.mutation(internal.semanticFileBudget.consumeAttachmentIngestBudget, {
			senderKey: 'flooder@example.com',
			count: BATCH,
		});
		const perSenderCalls = PER_SENDER_CAPACITY / BATCH;
		for (let i = 1; i < perSenderCalls; i++) {
			await t.mutation(internal.semanticFileBudget.consumeAttachmentIngestBudget, {
				senderKey: 'flooder@example.com',
				count: BATCH,
			});
		}
		const refusedCalls = 12;
		for (let i = 0; i < refusedCalls; i++) {
			const res = await t.mutation(internal.semanticFileBudget.consumeAttachmentIngestBudget, {
				senderKey: 'flooder@example.com',
				count: BATCH,
			});
			expect(res.ok).toBe(false);
		}

		// If those refusals had reached the global bucket they would have taken
		// `refusedCalls * BATCH` tokens out of it. Draining the global bucket to
		// exactly its remaining capacity proves they did not.
		const alreadySpent = PER_SENDER_CAPACITY;
		const remaining = GLOBAL_CAPACITY - alreadySpent;
		for (let i = 0; i < remaining / BATCH; i++) {
			const res = await t.mutation(internal.semanticFileBudget.consumeAttachmentIngestBudget, {
				// A fresh sender each time, so only the global bucket can refuse.
				senderKey: `sender-${i}@example.com`,
				count: BATCH,
			});
			expect(res.ok).toBe(true);
		}

		// The global bucket is empty now — a sender with a full per-sender bucket
		// is refused by the global one.
		const overGlobal = await t.mutation(internal.semanticFileBudget.consumeAttachmentIngestBudget, {
			senderKey: 'fresh@example.com',
			count: BATCH,
		});
		expect(overGlobal.ok).toBe(false);
	});

	it('charges nothing for a message with no eligible attachments', async () => {
		const t = setupTest();

		const res = await t.mutation(internal.semanticFileBudget.consumeAttachmentIngestBudget, {
			senderKey: 'bob@example.com',
			count: 0,
		});
		expect(res.ok).toBe(true);

		// The bucket was untouched, so its full capacity is still spendable.
		for (let i = 0; i < PER_SENDER_CAPACITY / BATCH; i++) {
			const spend = await t.mutation(internal.semanticFileBudget.consumeAttachmentIngestBudget, {
				senderKey: 'bob@example.com',
				count: BATCH,
			});
			expect(spend.ok).toBe(true);
		}
	});
});

describe('inbox.inboundIngest.ingestFromWebhook — over the budget', () => {
	it('still stores the message, its metadata and the raw .eml, and indexes nothing', async () => {
		const t = setupTest();
		// No MTA configured ⇒ no scan is attempted and no verdict is asserted.
		delete process.env['MTA_INTERNAL_URL'];
		delete process.env['MTA_API_URL'];
		delete process.env['MTA_API_KEY'];

		// Drain the GLOBAL bucket before the message arrives. `receiveMessage`
		// upserts the sender contact and capture keys on that contact id, which
		// this test cannot know in advance — the global bucket refuses whatever
		// per-sender key it ends up using.
		for (let i = 0; i < GLOBAL_CAPACITY / BATCH; i++) {
			const res = await t.mutation(internal.semanticFileBudget.consumeAttachmentIngestBudget, {
				senderKey: `drain-${i}@example.com`,
				count: BATCH,
			});
			expect(res.ok).toBe(true);
		}

		const raw = [
			'From: Flooder <flooder@example.com>',
			'To: inbox@example.com',
			'Subject: budget',
			'Message-ID: <budget-1@example.com>',
			'Content-Type: multipart/mixed; boundary="bb"',
			'',
			'--bb',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Body.',
			'',
			'--bb',
			'Content-Type: text/plain; name="notes.txt"',
			'Content-Disposition: attachment; filename="notes.txt"',
			'Content-Transfer-Encoding: base64',
			'',
			Buffer.from('a real document that would be summarised').toString('base64'),
			'',
			'--bb--',
			'',
		].join('\r\n');

		await t.action(internal.inbox.inboundIngest.ingestFromWebhook, {
			mail: {
				from: 'Flooder <flooder@example.com>',
				to: 'inbox@example.com',
				subject: 'budget',
				textBody: 'Body.',
				headers: {},
				messageId: '<budget-1@example.com>',
				attachments: [
					{ filename: 'notes.txt', contentType: 'text/plain', size: 39, partIndex: '1' },
				],
				timestamp: Date.now(),
			},
			rawBytesBase64: Buffer.from(raw, 'latin1').toString('base64'),
		});

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		const row = rows[0]!;
		// The bytes survive: the message is stored, described and downloadable.
		expect(row.rawStorageId).toBeTruthy();
		expect(row.rawSize).toBeGreaterThan(0);
		expect(row.attachmentMeta).toContain('notes.txt');

		// Only the model spend was skipped.
		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(0);
	});
});
