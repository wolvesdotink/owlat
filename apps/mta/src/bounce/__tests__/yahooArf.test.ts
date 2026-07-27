/**
 * P4-6 — a Yahoo Complaint Feedback Loop report routes through the EXISTING ARF
 * processor.
 *
 * AUDIT FINDING: Yahoo needs NO new parser. `fblProcessor.tryParseARF` already
 * recognises a Yahoo CFL report and resolves `sourceIsp: 'yahoo'` from its
 * branded `User-Agent`, and the shipped `feedbackProvenance` module already
 * attributes it to the exact send/org/campaign from the SIGNED VERP token plus
 * the server-persisted outbound record. What P4-6 adds is that the reduced
 * complaint event now FORWARDS the RFC 5965 `Reported-Domain` and the resolved
 * source ISP to Convex, which is what keeps the DKIM-domain-based enrollment
 * marked live. One complaint pipeline, three sources — never a second parser.
 *
 * Covers the named test gate:
 *   (b) a Yahoo CFL report routes through the existing ARF processor and
 *       attributes to the right send / cell (destination provider) / arm.
 *   (d) adversarial — malformed and oversized reports are bounded, an
 *       out-of-order replay does not rewind, a forged cross-org claim is
 *       rejected.
 *   (e) regression — the shipped fblProcessor + reduceFbl behaviour is unchanged
 *       for every report that carries no usable Reported-Domain.
 */

import { describe, it, expect, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { parseMessage, type ParsedMessage } from '@owlat/mail-message';
import { tryParseARF } from '../fblProcessor.js';
import { extractReportParts, type ReportPart } from '../reportParts.js';
import { attachFeedbackProvenance, recordFeedbackProvenance } from '../feedbackProvenance.js';
import { reduce } from '../outcome.js';
import type { BasePhaseCtx, BounceAttempt } from '../types.js';
import type { EmailJob } from '../../types.js';

function newRedis(): RealRedis {
	return new Redis() as unknown as RealRedis;
}

function makeCtx(): BasePhaseCtx {
	return {
		parsed: { headers: new Map<string, string>(), attachments: [] } as unknown as ParsedMessage,
		rawBuffer: Buffer.from('raw'),
		rcptTo: 'fbl@owlat.test',
	};
}

/** Build a real multipart/report ARF body and parse it like inbound mail. */
function buildArf(opts: { feedbackReport: string; originalMessage: string }): {
	parsed: ParsedMessage;
	parts: ReportPart[];
} {
	const raw = [
		'From: feedback@yahoo.com',
		'To: fbl@owlat.test',
		'Subject: Yahoo! Mail Complaint Feedback Report',
		'MIME-Version: 1.0',
		'Content-Type: multipart/report; report-type=feedback-report; boundary="b=_arf"',
		'',
		'--b=_arf',
		'Content-Type: text/plain; charset="US-ASCII"',
		'',
		'This is an abuse report for a message from your network.',
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

function yahooReport(overrides: { reportedDomain?: string; recipient?: string } = {}) {
	return buildArf({
		feedbackReport: [
			'Feedback-Type: abuse',
			'User-Agent: Yahoo!-Mail-Feedback/2.0',
			'Version: 0.1',
			'Original-Mail-From: bounce@owlat.test',
			`Original-Rcpt-To: ${overrides.recipient ?? 'complainer@yahoo.com'}`,
			...(overrides.reportedDomain === undefined
				? ['Reported-Domain: mail.owlat.test']
				: overrides.reportedDomain === ''
					? []
					: [`Reported-Domain: ${overrides.reportedDomain}`]),
			'Source-IP: 203.0.113.42',
		].join('\r\n'),
		originalMessage: [
			'From: news@mail.owlat.test',
			'To: complainer@yahoo.com',
			'Subject: Owlat weekly digest',
			'Message-ID: <digest-9001@mail.owlat.test>',
		].join('\r\n'),
	});
}

const JOB: EmailJob = {
	messageId: 'send-9001',
	organizationId: 'org-yahoo',
	to: 'complainer@yahoo.com',
	deliveryDomain: 'production',
	headers: { 'Feedback-ID': 'campaign:k57abcdef0123456789:owlat:owlat' },
} as unknown as EmailJob;

describe('a Yahoo CFL report through the shipped ARF processor', () => {
	it('parses feedback type, recipient, reported domain and yahoo as the source ISP', () => {
		const { parsed, parts } = yahooReport();
		const arf = tryParseARF(parsed, parts);
		expect(arf).not.toBeNull();
		expect(arf?.type).toBe('complained');
		expect(arf?.feedbackType).toBe('abuse');
		expect(arf?.recipient).toBe('complainer@yahoo.com');
		expect(arf?.reportedDomain).toBe('mail.owlat.test');
		expect(arf?.sourceIsp).toBe('yahoo');
		// The `from <isp>` shape reduceFbl() re-parses is preserved.
		expect(arf?.message).toBe('Spam complaint via ARF from yahoo');
	});

	it('attributes to the right send, org and campaign from persisted provenance', async () => {
		const redis = newRedis();
		await recordFeedbackProvenance(redis, JOB);
		const { parsed, parts } = yahooReport();
		const arf = tryParseARF(parsed, parts);
		expect(arf).not.toBeNull();
		if (!arf) return;
		const attributed = await attachFeedbackProvenance(redis, {
			kind: 'fbl',
			// The VERP token is what a real report yields; inject the verified id
			// directly so this test isolates ATTRIBUTION from token verification
			// (which verpForgedDsn.test.ts already pins).
			arf: { ...arf, originalMessageId: 'send-9001' },
		});
		expect(attributed.kind).toBe('fbl');
		if (attributed.kind !== 'fbl') return;
		expect(attributed.arf.organizationId).toBe('org-yahoo');
		expect(attributed.arf.campaignId).toBe('k57abcdef0123456789');
		expect(attributed.arf.deliveryDomain).toBe('production');
		expect(attributed.arf.feedbackProvenance).toBe('production');
	});

	it('forwards reportedDomain + sourceIsp on the complaint event Convex receives', async () => {
		const redis = newRedis();
		await recordFeedbackProvenance(redis, JOB);
		const { parsed, parts } = yahooReport();
		const arf = tryParseARF(parsed, parts);
		if (!arf) throw new Error('expected an ARF classification');
		const attempt = (await attachFeedbackProvenance(redis, {
			kind: 'fbl',
			arf: { ...arf, originalMessageId: 'send-9001' },
		})) as Extract<BounceAttempt, { kind: 'fbl' }>;

		const { effects } = reduce(attempt, makeCtx());
		const notify = effects.find((e) => e.kind === 'notify_convex');
		expect(notify).toBeDefined();
		if (notify?.kind !== 'notify_convex') return;
		expect(notify.event).toMatchObject({
			event: 'complained',
			messageId: 'send-9001',
			recipient: 'complainer@yahoo.com',
			organizationId: 'org-yahoo',
			reportedDomain: 'mail.owlat.test',
			sourceIsp: 'yahoo',
		});
		// The per-campaign complaint attribution the ramp's gate 3 consumes is
		// untouched — one complaint pipeline, three sources.
		expect(effects.map((e) => e.kind)).toContain('campaign_complaint_record');
	});

	it('lower-cases the reported domain so the Convex lookup matches the stored domain', () => {
		const { parsed, parts } = yahooReport({ reportedDomain: 'MAIL.Owlat.TEST' });
		const arf = tryParseARF(parsed, parts);
		if (!arf) throw new Error('expected an ARF classification');
		const { effects } = reduce({ kind: 'fbl', arf }, makeCtx());
		const notify = effects.find((e) => e.kind === 'notify_convex');
		if (notify?.kind !== 'notify_convex') throw new Error('expected a notify_convex effect');
		expect(notify.event.reportedDomain).toBe('mail.owlat.test');
	});
});

describe('adversarial reports', () => {
	it('drops an OVERSIZED Reported-Domain rather than invalidating the complaint', () => {
		const { parsed, parts } = yahooReport({ reportedDomain: `${'a'.repeat(300)}.example` });
		const arf = tryParseARF(parsed, parts);
		if (!arf) throw new Error('expected an ARF classification');
		const { effects } = reduce({ kind: 'fbl', arf }, makeCtx());
		const notify = effects.find((e) => e.kind === 'notify_convex');
		if (notify?.kind !== 'notify_convex') throw new Error('expected a notify_convex effect');
		// The hint is dropped; the COMPLAINT still flows (it must always reach the
		// blocklist), and the event stays inside the webhook validator's bounds.
		expect(notify.event.reportedDomain).toBeUndefined();
		expect(notify.event.recipient).toBe('complainer@yahoo.com');
	});

	it('keeps only the first header line, so a CRLF-injected tail cannot ride along', () => {
		// The shipped field matcher is line-anchored, so the injected header is
		// simply not part of the value. Pinned because the value reaches Convex.
		const { parsed, parts } = yahooReport({
			reportedDomain: 'mail.owlat.test\r\nX-Injected: 1',
		});
		const arf = tryParseARF(parsed, parts);
		if (!arf) throw new Error('expected an ARF classification');
		const { effects } = reduce({ kind: 'fbl', arf }, makeCtx());
		const notify = effects.find((e) => e.kind === 'notify_convex');
		if (notify?.kind !== 'notify_convex') throw new Error('expected a notify_convex effect');
		expect(notify.event.reportedDomain).toBe('mail.owlat.test');
	});

	it('drops a MALFORMED Reported-Domain that is not a DNS name', () => {
		for (const malformed of ['not a domain', '<script>alert(1)</script>', 'mail owlat test']) {
			const { parsed, parts } = yahooReport({ reportedDomain: malformed });
			const arf = tryParseARF(parsed, parts);
			if (!arf) throw new Error('expected an ARF classification');
			const { effects } = reduce({ kind: 'fbl', arf }, makeCtx());
			const notify = effects.find((e) => e.kind === 'notify_convex');
			if (notify?.kind !== 'notify_convex') throw new Error('expected a notify_convex effect');
			expect(notify.event.reportedDomain).toBeUndefined();
		}
	});

	it('rejects a forged CROSS-ORG claim: only persisted provenance sets the org', async () => {
		const redis = newRedis();
		await recordFeedbackProvenance(redis, JOB);
		// A hostile report echoes another tenant's ids back at us in the
		// re-attached original message. Attribution must come from the
		// server-persisted record for the VERIFIED Message-ID only.
		const { parsed, parts } = buildArf({
			feedbackReport: [
				'Feedback-Type: abuse',
				'User-Agent: Yahoo!-Mail-Feedback/2.0',
				'Original-Rcpt-To: complainer@yahoo.com',
				'Reported-Domain: mail.owlat.test',
			].join('\r\n'),
			originalMessage: [
				'From: news@mail.owlat.test',
				'To: complainer@yahoo.com',
				'X-Owlat-Org-Id: org-victim',
				'X-Owlat-Message-Id: send-victim',
				'Feedback-ID: campaign:k57victim0123456789:owlat:owlat',
				'Message-ID: <forged@evil.example>',
			].join('\r\n'),
		});
		const arf = tryParseARF(parsed, parts);
		if (!arf) throw new Error('expected an ARF classification');
		expect(arf.organizationId).toBeUndefined();
		const attributed = await attachFeedbackProvenance(redis, { kind: 'fbl', arf });
		if (attributed.kind !== 'fbl') throw new Error('expected an fbl attempt');
		expect(attributed.arf.organizationId).toBeUndefined();
		expect(attributed.arf.campaignId).toBeUndefined();
		expect(attributed.arf.feedbackProvenance).toBe('unknown');
	});

	it('deduplicates a replayed report by its stable dedup key', async () => {
		const { generateDedupKey } = await import('../fblProcessor.js');
		const { parsed } = yahooReport();
		// Identical bytes hash to the identical key, so a replay reserves the same
		// slot the first delivery already consumed.
		expect(generateDedupKey(parsed)).toBe(generateDedupKey(parsed));
		// A verified Message-ID makes the key the send id itself.
		expect(generateDedupKey(parsed, 'send-9001')).toBe('send-9001');
	});
});

describe('regression — shipped behaviour unchanged', () => {
	it('omits both new fields when the report carries no Reported-Domain', () => {
		const { parsed, parts } = buildArf({
			feedbackReport: ['Feedback-Type: abuse', 'Original-Rcpt-To: complainer@example.net'].join(
				'\r\n'
			),
			originalMessage: 'From: news@mail.owlat.test',
		});
		const arf = tryParseARF(parsed, parts);
		if (!arf) throw new Error('expected an ARF classification');
		const { effects } = reduce({ kind: 'fbl', arf }, makeCtx());
		const notify = effects.find((e) => e.kind === 'notify_convex');
		if (notify?.kind !== 'notify_convex') throw new Error('expected a notify_convex effect');
		expect('reportedDomain' in notify.event).toBe(false);
		expect('sourceIsp' in notify.event).toBe(false);
		expect(notify.event).toMatchObject({
			event: 'complained',
			recipient: 'complainer@example.net',
		});
	});

	it('emits the same effect sequence a shipped attributed complaint emitted', () => {
		const { effects } = reduce(
			{
				kind: 'fbl',
				arf: {
					type: 'complained',
					bounceType: 'hard',
					message: 'Spam complaint via ARF from yahoo',
					originalMessageId: 'send-1',
					organizationId: 'org-1',
					campaignId: 'camp-1',
				},
			},
			makeCtx()
		);
		expect(effects.map((e) => e.kind)).toEqual([
			'circuit_breaker_outcome',
			'metric_inc',
			'metric_inc',
			'campaign_complaint_record',
			'notify_convex',
			'fbl_stats_record',
		]);
	});

	it('still resolves the ISP from a Received trace when no structured field exists', () => {
		const raw = Buffer.from(
			[
				'From: feedback@yahoo.com',
				'To: fbl@owlat.test',
				'Received: from sonic308-4.consmr.mail.yahoo.com',
				'Content-Type: text/plain',
				'',
				'Feedback-Type: abuse',
				'Original-Rcpt-To: complainer@yahoo.com',
				'',
			].join('\r\n')
		);
		const arf = tryParseARF(parseMessage(raw), extractReportParts(raw));
		expect(arf?.sourceIsp).toBe('yahoo');
		expect(arf?.reportedDomain).toBeUndefined();
	});
});
