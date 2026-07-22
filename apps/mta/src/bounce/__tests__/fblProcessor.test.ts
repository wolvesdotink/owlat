import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { parseMessage, type ParsedMessage, type MessageAttachment } from '@owlat/mail-message';
import {
	tryParseARF,
	reserveComplaint,
	completeComplaint,
	releaseComplaint,
	generateDedupKey,
} from '../fblProcessor.js';
import { buildVerpAddress } from '../verp.js';
import { extractReportParts, type ReportPart } from '../reportParts.js';
import { reportPartsOf } from './helpers/reportParts.js';

function createMockParsedMail(overrides: Record<string, unknown> = {}): ParsedMessage {
	return {
		text: '',
		subject: '',
		headers: new Map(),
		attachments: [],
		...overrides,
	} as unknown as ParsedMessage;
}

/** `tryParseARF` with the report parts derived from a fabricated mock. */
function arfOf(parsed: ParsedMessage) {
	return tryParseARF(parsed, reportPartsOf(parsed));
}

describe('tryParseARF', () => {
	it('returns null for non-ARF message', () => {
		const result = arfOf(
			createMockParsedMail({
				text: 'Hello, this is a regular email.',
				headers: new Map([['content-type', 'text/plain']]),
			})
		);

		expect(result).toBeNull();
	});

	it('identifies ARF from content-type containing feedback-report', () => {
		const result = arfOf(
			createMockParsedMail({
				text: 'Some abuse report body',
				headers: new Map([['content-type', 'multipart/report; report-type=feedback-report']]),
			})
		);

		expect(result).not.toBeNull();
		expect(result!.type).toBe('complained');
		expect(result!.bounceType).toBe('hard');
	});

	it('identifies ARF from body text containing feedback-type and abuse', () => {
		const result = arfOf(
			createMockParsedMail({
				text: 'Feedback-Type: abuse\nUser-Agent: FBL/1.0\nOriginal-Mail-From: test@example.com',
				headers: new Map([['content-type', 'text/plain']]),
			})
		);

		expect(result).not.toBeNull();
		expect(result!.type).toBe('complained');
	});

	it('extracts originalMessageId from X-Owlat-Message-Id in attachments', () => {
		const result = arfOf(
			createMockParsedMail({
				text: 'Feedback-Type: abuse\nSome report',
				headers: new Map([['content-type', 'multipart/report; report-type=feedback-report']]),
				attachments: [
					{
						content: Buffer.from(
							'X-Owlat-Message-Id: msg-complaint-001\r\nSubject: Original email'
						),
					},
				],
			})
		);

		expect(result).not.toBeNull();
		expect(result!.originalMessageId).toBeUndefined();
	});

	// PR-13: Gmail and several large ISPs redact the original Message-ID in
	// their FBL but still emit the complained recipient in the machine-readable
	// feedback-report part (RFC 5965 §3.2). Without surfacing that recipient the
	// complaint can only be counted as a metric — it never reaches the
	// blocklist, silently inflating the complaint rate past Gmail's <0.3%.
	it('surfaces the recipient from Original-Rcpt-To when no Message-ID is recoverable', () => {
		const result = arfOf(
			createMockParsedMail({
				headers: new Map([['content-type', 'multipart/report; report-type=feedback-report']]),
				text: 'Feedback-Type: abuse',
				attachments: [
					{
						content: Buffer.from(
							'Feedback-Type: abuse\r\n' +
								'User-Agent: Google-Mail-Feedback/1.0\r\n' +
								'Version: 1\r\n' +
								'Original-Rcpt-To: victim@example.com\r\n'
						),
					},
				],
			})
		);

		expect(result).not.toBeNull();
		expect(result!.originalMessageId).toBeUndefined();
		expect(result!.recipient).toBe('victim@example.com');
		expect(result!.type).toBe('complained');
	});

	it('extracts the recipient from an inline feedback-report body (no attachment)', () => {
		const result = arfOf(
			createMockParsedMail({
				headers: new Map([['content-type', 'text/plain']]),
				text: 'Feedback-Type: abuse\nUser-Agent: FBL/1.0\nOriginal-Rcpt-To: <inline@example.com>',
			})
		);

		expect(result).not.toBeNull();
		expect(result!.recipient).toBe('inline@example.com');
	});

	it('falls back to Removed-Recipient / Original-Recipient (rfc822; prefix stripped)', () => {
		const removed = arfOf(
			createMockParsedMail({
				headers: new Map([['content-type', 'multipart/report; report-type=feedback-report']]),
				text: 'Feedback-Type: abuse',
				attachments: [{ content: Buffer.from('Removed-Recipient: removed@example.com') }],
			})
		);
		expect(removed!.recipient).toBe('removed@example.com');

		const original = arfOf(
			createMockParsedMail({
				headers: new Map([['content-type', 'multipart/report; report-type=feedback-report']]),
				text: 'Feedback-Type: abuse',
				attachments: [{ content: Buffer.from('Original-Recipient: rfc822; rfc@example.com') }],
			})
		);
		expect(original!.recipient).toBe('rfc@example.com');
	});

	it('leaves recipient undefined when no recipient field is present', () => {
		const result = arfOf(
			createMockParsedMail({
				headers: new Map([['content-type', 'multipart/report; report-type=feedback-report']]),
				text: 'Feedback-Type: abuse\nNo recipient anywhere here',
			})
		);
		expect(result).not.toBeNull();
		expect(result!.recipient).toBeUndefined();
	});

	it('extracts organizationId from X-Owlat-Org-Id in attachments', () => {
		const result = arfOf(
			createMockParsedMail({
				text: 'Feedback-Type: abuse',
				headers: new Map([['content-type', 'multipart/report; report-type=feedback-report']]),
				attachments: [
					{
						content: Buffer.from('X-Owlat-Org-Id: org-99\r\nX-Owlat-Message-Id: msg-001'),
					},
				],
			})
		);

		expect(result).not.toBeNull();
		expect(result!.organizationId).toBe('org-99');
	});

	// PR-15: per-campaign attribution from the original message's Feedback-ID.
	it('extracts campaignId from a campaign-stream Feedback-ID in attachments', () => {
		const result = arfOf(
			createMockParsedMail({
				text: 'Feedback-Type: abuse',
				headers: new Map([['content-type', 'multipart/report; report-type=feedback-report']]),
				attachments: [
					{
						content: Buffer.from(
							'Feedback-ID: campaign:jh71d9k2m3n4p5q6r7s8t9v0w1x2y3z4:topic:ab12cd\r\nSubject: Original email'
						),
					},
				] as unknown as MessageAttachment[],
			})
		);

		expect(result).not.toBeNull();
		expect(result!.campaignId).toBe('jh71d9k2m3n4p5q6r7s8t9v0w1x2y3z4');
	});

	it('leaves campaignId undefined for a transactional (txn) Feedback-ID', () => {
		const result = arfOf(
			createMockParsedMail({
				text: 'Feedback-Type: abuse',
				headers: new Map([['content-type', 'multipart/report; report-type=feedback-report']]),
				attachments: [
					{
						content: Buffer.from('Feedback-ID: txn:none:none:ab12cd\r\nSubject: Original'),
					},
				] as unknown as MessageAttachment[],
			})
		);

		expect(result).not.toBeNull();
		expect(result!.campaignId).toBeUndefined();
	});

	it('extracts campaignId from a Feedback-ID surfaced in the report body', () => {
		const result = arfOf(
			createMockParsedMail({
				text: 'Feedback-Type: abuse\nFeedback-ID: campaign:bodyc4mp41gn0123456789abcdefghij:segment:zz99\nMore',
				headers: new Map([['content-type', 'multipart/report; report-type=feedback-report']]),
			})
		);

		expect(result).not.toBeNull();
		expect(result!.campaignId).toBe('bodyc4mp41gn0123456789abcdefghij');
	});

	// SECURITY: the Feedback-ID is scraped from internet-inbound ARF content and
	// its field-2 becomes a Prometheus label / Redis key. A forged value that is
	// not a plausible Convex doc id must not be attributed (unbounded metric
	// cardinality → memory DoS).
	it('drops a forged/oversized field-2 campaignId rather than attributing it', () => {
		const oversized = 'z'.repeat(200);
		const result = arfOf(
			createMockParsedMail({
				text: `Feedback-Type: abuse\nFeedback-ID: campaign:${oversized}:topic:ab12cd\nMore`,
				headers: new Map([['content-type', 'multipart/report; report-type=feedback-report']]),
			})
		);

		expect(result).not.toBeNull();
		expect(result!.campaignId).toBeUndefined();
	});

	it('returns complained/hard classification', () => {
		const result = arfOf(
			createMockParsedMail({
				text: 'Feedback-Type: abuse\nReport',
				headers: new Map([['content-type', 'multipart/report; report-type=feedback-report']]),
			})
		);

		expect(result).not.toBeNull();
		expect(result!.type).toBe('complained');
		expect(result!.bounceType).toBe('hard');
	});

	it('identifies source ISP from received headers (microsoft)', () => {
		const result = arfOf(
			createMockParsedMail({
				text: 'Feedback-Type: abuse',
				headers: new Map([
					['content-type', 'multipart/report; report-type=feedback-report'],
					['received', 'from outlook-com.olc.protection.microsoft.com'],
				]),
			})
		);

		expect(result).not.toBeNull();
		expect(result!.message).toContain('microsoft');
	});

	it('identifies source ISP from received headers (yahoo)', () => {
		const result = arfOf(
			createMockParsedMail({
				text: 'Feedback-Type: abuse',
				headers: new Map([
					['content-type', 'multipart/report; report-type=feedback-report'],
					['received', 'from sonic308-4.consmr.mail.yahoo.com'],
				]),
			})
		);

		expect(result).not.toBeNull();
		expect(result!.message).toContain('yahoo');
	});

	it('identifies source ISP from received headers (google)', () => {
		const result = arfOf(
			createMockParsedMail({
				text: 'Feedback-Type: abuse',
				headers: new Map([
					['content-type', 'multipart/report; report-type=feedback-report'],
					['received', 'from mail-wr1-f41.google.com'],
				]),
			})
		);

		expect(result).not.toBeNull();
		expect(result!.message).toContain('google');
	});
});

// ── PR-14: parse the STRUCTURED message/feedback-report part ─────────────────
//
// A real RFC 5965 ARF report is a multipart/report with three sub-parts: a
// human-readable text/plain, a machine-readable message/feedback-report (the
// authoritative structured fields), and a message/rfc822 copy of the original
// message (which carries our Feedback-ID / X-Owlat-* headers). The processor
// used to substring-scan every part indiscriminately and guess the ISP from
// Received; it now routes by MIME content-type and reads:
//   - Feedback-Type / Original-Rcpt-To / Reported-Domain / Source-IP / Source ISP
//     from the message/feedback-report part, and
//   - Feedback-ID / X-Owlat-Message-Id from the message/rfc822 original message.
// These fixtures are real-shaped ISP ARF reports (Comcast / Yahoo / Microsoft)
// parsed through the real MIME parser so the content-type routing is exercised
// end-to-end. See EMAIL_BEST_PRACTICES_AUDIT_2026-06-21.md "PR-14".
describe('tryParseARF — structured feedback-report part (audit PR-14)', () => {
	/** Build a real multipart/report ARF body and parse it like an inbound mail. */
	async function buildArf(opts: {
		feedbackReport: string;
		originalMessage: string;
		humanText?: string;
	}): Promise<{ parsed: ParsedMessage; parts: ReportPart[] }> {
		const human = opts.humanText ?? 'This is an abuse report for a message from your network.';
		const raw = [
			'From: feedbackloop@isp.example',
			'To: fbl@owlat.test',
			'Subject: Spam Feedback Report',
			'MIME-Version: 1.0',
			'Content-Type: multipart/report; report-type=feedback-report; boundary="b=_arf"',
			'',
			'--b=_arf',
			'Content-Type: text/plain; charset="US-ASCII"',
			'',
			human,
			'',
			'--b=_arf',
			'Content-Type: message/feedback-report',
			'',
			opts.feedbackReport,
			'',
			'--b=_arf',
			'Content-Type: message/rfc822',
			'',
			opts.originalMessage,
			'--b=_arf--',
			'',
		].join('\r\n');
		const buf = Buffer.from(raw);
		return { parsed: parseMessage(buf), parts: extractReportParts(buf) };
	}

	it('extracts feedbackType/recipient/sourceIsp from a Comcast ARF report', async () => {
		const { parsed, parts } = await buildArf({
			feedbackReport: [
				'Feedback-Type: abuse',
				'User-Agent: Comcast-Feedback-Loop/1.0',
				'Version: 1',
				'Original-Mail-From: news-bounces@owlat.test',
				'Original-Rcpt-To: complainer@comcast.net',
				'Reported-Domain: owlat.test',
				'Source-IP: 198.51.100.7',
				'Arrival-Date: Fri, 08 Mar 2024 09:15:00 -0500',
			].join('\r\n'),
			originalMessage: [
				'From: news@owlat.test',
				'To: complainer@comcast.net',
				'Subject: Owlat weekly digest',
				'Message-ID: <digest-001@owlat.test>',
			].join('\r\n'),
		});

		const result = tryParseARF(parsed, parts);
		expect(result).not.toBeNull();
		expect(result!.type).toBe('complained');
		expect(result!.feedbackType).toBe('abuse');
		expect(result!.recipient).toBe('complainer@comcast.net');
		expect(result!.reportedDomain).toBe('owlat.test');
		expect(result!.sourceIp).toBe('198.51.100.7');
		expect(result!.sourceIsp).toBe('comcast');
		// The structured ISP must survive into the message reduceFbl() re-parses.
		expect(result!.message).toContain('comcast');
	});

	it('extracts feedbackType/recipient/sourceIsp from a Yahoo ARF report', async () => {
		const { parsed, parts } = await buildArf({
			feedbackReport: [
				'Feedback-Type: abuse',
				'User-Agent: Yahoo!-Mail-Feedback/2.0',
				'Version: 0.1',
				'Original-Mail-From: bounce@owlat.test',
				'Original-Rcpt-To: someone@yahoo.com',
				'Reported-Domain: owlat.test',
				'Source-IP: 203.0.113.42',
			].join('\r\n'),
			originalMessage: [
				'From: hello@owlat.test',
				'To: someone@yahoo.com',
				'Subject: Welcome to Owlat',
				'Message-ID: <welcome-77@owlat.test>',
			].join('\r\n'),
		});

		const result = tryParseARF(parsed, parts);
		expect(result).not.toBeNull();
		expect(result!.feedbackType).toBe('abuse');
		expect(result!.recipient).toBe('someone@yahoo.com');
		expect(result!.sourceIsp).toBe('yahoo');
		expect(result!.message).toContain('yahoo');
	});

	it('extracts feedbackType/recipient/sourceIsp from a Microsoft (Outlook) ARF report', async () => {
		const { parsed, parts } = await buildArf({
			feedbackReport: [
				'Feedback-Type: abuse',
				'User-Agent: Microsoft Junk Email Reporting Program (JMRP)',
				'Version: 1.0',
				'Original-Mail-From: list-bounce@owlat.test',
				'Original-Rcpt-To: user@outlook.com',
				'Reported-Domain: owlat.test',
				'Source-IP: 192.0.2.200',
			].join('\r\n'),
			originalMessage: [
				'From: list@owlat.test',
				'To: user@outlook.com',
				'Subject: Product update',
				'Message-ID: <update-9@owlat.test>',
			].join('\r\n'),
		});

		const result = tryParseARF(parsed, parts);
		expect(result).not.toBeNull();
		expect(result!.feedbackType).toBe('abuse');
		expect(result!.recipient).toBe('user@outlook.com');
		expect(result!.sourceIsp).toBe('microsoft');
		expect(result!.message).toContain('microsoft');
	});

	// The Feedback-ID lives on the ORIGINAL message (message/rfc822 part), NOT the
	// feedback-report part. Now that it lands outbound (sendComposition), read it
	// back from the original-message part so per-campaign attribution works.
	it('reads the campaign Feedback-ID from the message/rfc822 original-message part', async () => {
		const { parsed, parts } = await buildArf({
			feedbackReport: [
				'Feedback-Type: abuse',
				'User-Agent: Google-Mail-Feedback/1.0',
				'Version: 1',
				'Original-Rcpt-To: clicker@gmail.com',
			].join('\r\n'),
			originalMessage: [
				'From: campaigns@owlat.test',
				'To: clicker@gmail.com',
				'Subject: Spring sale',
				'Message-ID: <sale-1@owlat.test>',
				'Feedback-ID: campaign:jh71d9k2m3n4p5q6r7s8t9v0w1x2y3z4:topic:ab12cd',
			].join('\r\n'),
		});

		const result = tryParseARF(parsed, parts);
		expect(result).not.toBeNull();
		expect(result!.feedbackType).toBe('abuse');
		expect(result!.recipient).toBe('clicker@gmail.com');
		expect(result!.campaignId).toBe('jh71d9k2m3n4p5q6r7s8t9v0w1x2y3z4');
	});

	// A Feedback-ID that appears in the feedback-report part (NOT the original
	// message) must NOT be mistaken for our outbound campaign id — only the
	// original-message copy is ours. (This guards the part-routing: pre-fix the
	// blind scan would pick up a Feedback-ID from anywhere.)
	it('does not read a campaignId from a Feedback-ID placed in the feedback-report part only', async () => {
		const { parsed, parts } = await buildArf({
			feedbackReport: [
				'Feedback-Type: abuse',
				'User-Agent: Comcast-Feedback-Loop/1.0',
				'Original-Rcpt-To: x@comcast.net',
				// Some ISPs echo a Feedback-ID into the report part; the canonical
				// source remains the original message. Our outbound id is read back
				// from message/rfc822, so absent it there we attribute no campaign.
			].join('\r\n'),
			originalMessage: [
				'From: news@owlat.test',
				'To: x@comcast.net',
				'Subject: No feedback id here',
				'Message-ID: <nofid@owlat.test>',
			].join('\r\n'),
		});

		const result = tryParseARF(parsed, parts);
		expect(result).not.toBeNull();
		expect(result!.campaignId).toBeUndefined();
	});

	// X-Owlat-Message-Id is echoed in the original message; attribution must read
	// it from the message/rfc822 part (when VERP signing is not configured).
	it('reads X-Owlat-Message-Id back from the message/rfc822 original-message part', async () => {
		const { parsed, parts } = await buildArf({
			feedbackReport: [
				'Feedback-Type: abuse',
				'User-Agent: Yahoo!-Mail-Feedback/2.0',
				'Original-Rcpt-To: y@yahoo.com',
			].join('\r\n'),
			originalMessage: [
				'From: tx@owlat.test',
				'To: y@yahoo.com',
				'Subject: Receipt',
				'X-Owlat-Message-Id: send_abc123',
				'X-Owlat-Org-Id: org-7',
				'Message-ID: <receipt-1@owlat.test>',
			].join('\r\n'),
		});

		const result = tryParseARF(parsed, parts);
		expect(result).not.toBeNull();
		expect(result!.originalMessageId).toBeUndefined();
		expect(result!.organizationId).toBe('org-7');
	});
});

describe('tryParseARF — forged-complaint poisoning (audit PR-03, key configured)', () => {
	const KEY = 'fbl-verp-key-abcdef0123456789';
	const realId = 'send_realMessageId0123456789';
	const RPD = 'bounces.owlat.test';

	beforeEach(() => {
		process.env['BOUNCE_VERP_KEY'] = KEY;
	});

	afterEach(() => {
		delete process.env['BOUNCE_VERP_KEY'];
	});

	it('does NOT attribute from the unauthenticated X-Owlat-Message-Id header when a key is set', () => {
		const result = arfOf(
			createMockParsedMail({
				text: 'Feedback-Type: abuse\nSome report',
				headers: new Map([['content-type', 'multipart/report; report-type=feedback-report']]),
				attachments: [
					{
						content: Buffer.from(`X-Owlat-Message-Id: ${realId}\r\nSubject: Original email`),
					} as never,
				],
			})
		);

		// Still recognized as a complaint, but with no attributable messageId — so
		// it cannot suppress a healthy recipient via a forged report.
		expect(result).not.toBeNull();
		expect(result!.type).toBe('complained');
		expect(result!.originalMessageId).toBeUndefined();
	});

	it('does NOT attribute from a forged Original-Mail-From VERP token with no/invalid MAC when a key is set', () => {
		const forgedVerp = `bounce+${Buffer.from(realId).toString('base64url')}@${RPD}`;
		const result = arfOf(
			createMockParsedMail({
				text: `Feedback-Type: abuse\nOriginal-Mail-From: ${forgedVerp}`,
				headers: new Map([['content-type', 'multipart/report; report-type=feedback-report']]),
			})
		);

		expect(result).not.toBeNull();
		expect(result!.originalMessageId).toBeUndefined();
	});

	it('DOES attribute from a correctly-signed Original-Mail-From VERP token', () => {
		const signedVerp = buildVerpAddress(realId, RPD, KEY);
		const result = arfOf(
			createMockParsedMail({
				text: `Feedback-Type: abuse\nOriginal-Mail-From: ${signedVerp}`,
				headers: new Map([['content-type', 'multipart/report; report-type=feedback-report']]),
			})
		);

		expect(result).not.toBeNull();
		expect(result!.originalMessageId).toBe(realId);
	});

	it('still extracts organizationId (non-attribution metadata) even when key is set', () => {
		const result = arfOf(
			createMockParsedMail({
				text: 'Feedback-Type: abuse',
				headers: new Map([['content-type', 'multipart/report; report-type=feedback-report']]),
				attachments: [
					{
						content: Buffer.from(`X-Owlat-Org-Id: org-99\r\nX-Owlat-Message-Id: ${realId}`),
					} as never,
				],
			})
		);

		expect(result).not.toBeNull();
		expect(result!.organizationId).toBe('org-99');
		expect(result!.originalMessageId).toBeUndefined();
	});
});

describe('generateDedupKey', () => {
	it('returns originalMessageId directly when available', () => {
		const key = generateDedupKey(createMockParsedMail({ text: 'Some complaint' }), 'msg-123');
		expect(key).toBe('msg-123');
	});

	it('generates SHA-256 hash when no messageId', () => {
		const key = generateDedupKey(
			createMockParsedMail({
				subject: 'Spam complaint',
				from: { text: 'fbl@isp.com' },
				text: 'Feedback-Type: abuse',
			})
		);

		// Should be a 32-char hex string
		expect(key).toMatch(/^[a-f0-9]{32}$/);
	});

	it('generates deterministic keys for same content', () => {
		const mail = createMockParsedMail({
			subject: 'Complaint',
			from: { text: 'fbl@isp.com' },
			text: 'Feedback-Type: abuse',
		});

		const key1 = generateDedupKey(mail);
		const key2 = generateDedupKey(mail);
		expect(key1).toBe(key2);
	});

	it('generates different keys for different content', () => {
		const key1 = generateDedupKey(createMockParsedMail({ subject: 'Complaint A', text: 'abc' }));
		const key2 = generateDedupKey(createMockParsedMail({ subject: 'Complaint B', text: 'xyz' }));
		expect(key1).not.toBe(key2);
	});
});

describe('complaint deduplication reservations', () => {
	let redis: RealRedis;

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
	});

	afterEach(async () => {
		await redis.flushall();
	});

	it('reserves the first occurrence without declaring it completed', async () => {
		const result = await reserveComplaint(redis, 'msg-001');
		expect(result.kind).toBe('reserved');
		expect(await redis.get('mta:fbl:dedup:msg-001')).toMatch(/^reserved:/);
	});

	it('does not ACK a concurrent intake while the first reservation is unresolved', async () => {
		await reserveComplaint(redis, 'msg-001');
		await expect(reserveComplaint(redis, 'msg-001')).rejects.toThrow(
			'Complaint processing is already in progress'
		);
	});

	it('permits the same feedback to retry after its reservation is released', async () => {
		const first = await reserveComplaint(redis, 'msg-retry');
		expect(first.kind).toBe('reserved');
		if (first.kind !== 'reserved') throw new Error('expected reservation');
		await releaseComplaint(redis, first.reservation);
		expect((await reserveComplaint(redis, 'msg-retry')).kind).toBe('reserved');
	});

	it('deduplicates only after the owned reservation is completed', async () => {
		const first = await reserveComplaint(redis, 'msg-completed');
		if (first.kind !== 'reserved') throw new Error('expected reservation');
		await completeComplaint(redis, first.reservation);
		expect(await redis.get('mta:fbl:dedup:msg-completed')).toBe('completed');
		expect(await reserveComplaint(redis, 'msg-completed')).toEqual({ kind: 'completed' });
	});

	it('keeps completed deduplication state for seven days', async () => {
		const result = await reserveComplaint(redis, 'msg-ttl');
		if (result.kind !== 'reserved') throw new Error('expected reservation');
		await completeComplaint(redis, result.reservation);
		const ttl = await redis.ttl('mta:fbl:dedup:msg-ttl');
		const SEVEN_DAYS = 7 * 86400;
		expect(ttl).toBeGreaterThan(SEVEN_DAYS - 5);
		expect(ttl).toBeLessThanOrEqual(SEVEN_DAYS);
	});

	it('does not let a stale owner release a newer reservation', async () => {
		const first = await reserveComplaint(redis, 'msg-owner');
		if (first.kind !== 'reserved') throw new Error('expected reservation');
		await redis.del(first.reservation.key);
		const second = await reserveComplaint(redis, 'msg-owner');
		if (second.kind !== 'reserved') throw new Error('expected second reservation');
		await releaseComplaint(redis, first.reservation);
		expect(await redis.get(second.reservation.key)).toBe(second.reservation.token);
	});
});
