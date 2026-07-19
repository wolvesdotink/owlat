/**
 * Raw-MIME report-part recovery (piece CI4, enumerated behavior change #1).
 *
 * `parseMessage` follows the `mailMime` attachment predicate, so a real DSN/ARF
 * that sets NEITHER a Content-Disposition nor a filename on its `message/*`
 * report parts sees those parts vanish from `parsed.attachments` (and a bare
 * `message/delivery-status` is folded into `parsed.text` by mailparser, but NOT
 * by `parseMessage`). `extractReportParts` walks them out of the raw MIME so the
 * bounce classifier + FBL scrapers still see the authoritative
 * `Status:`/`Action:`/`Diagnostic-Code:` and the echoed `X-Owlat-*` headers.
 *
 * This pins the DELIVERY-STATUS half of the change with a checked-in raw fixture
 * (the ARF half is pinned by `fblProcessor.test.ts`'s `buildArf` suite, I2): a
 * disposition-less `message/delivery-status` (+ `message/rfc822` + a
 * `text/rfc822-headers` case) is recovered by `extractReportParts` and drives
 * `parseBounce` to classify off `Status:`.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Unsigned VERP mode so the `X-Owlat-Message-Id` header-scrape fallback runs.
vi.mock('../verp.js', () => ({
	parseVerpAddress: vi.fn().mockReturnValue(null),
	isVerpSigningEnabled: vi.fn().mockReturnValue(false),
}));

import { parseMessage } from '@owlat/mail-message';
import { extractReportParts } from '../reportParts.js';
import { parseBounce } from '../parser.js';

/** A real, standards-shaped DSN whose `message/*` parts carry NO disposition. */
const DISPOSITIONLESS_DSN = [
	'From: MAILER-DAEMON@mx.example.com',
	'To: sender@example.org',
	'Subject: Delivery Status Notification (Failure)',
	'Date: Fri, 20 Jun 2026 08:15:00 +0000',
	'Message-ID: <dsn-nodisp-1@mx.example.com>',
	'MIME-Version: 1.0',
	'Content-Type: multipart/report; report-type=delivery-status; boundary="d1"',
	'',
	'--d1',
	'Content-Type: text/plain; charset=utf-8',
	'',
	'Your message to nobody@example.net could not be delivered.',
	'--d1',
	'Content-Type: message/delivery-status',
	'',
	'Reporting-MTA: dns; mx.example.com',
	'Final-Recipient: rfc822; nobody@example.net',
	'Action: failed',
	'Status: 5.1.1',
	'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
	'--d1',
	'Content-Type: text/rfc822-headers',
	'',
	'From: sender@example.org',
	'To: nobody@example.net',
	'Subject: Original',
	'X-Owlat-Message-Id: <owlat-msg-123@owlat.test>',
	'--d1',
	'Content-Type: message/rfc822',
	'',
	'From: sender@example.org',
	'To: nobody@example.net',
	'Subject: Original',
	'X-Owlat-Message-Id: <owlat-msg-123@owlat.test>',
	'',
	'Original body.',
	'--d1--',
	'',
].join('\r\n');

describe('extractReportParts recovers disposition-less report parts', () => {
	it('parseMessage.attachments drops the disposition-less message/delivery-status', () => {
		const parsed = parseMessage(Buffer.from(DISPOSITIONLESS_DSN));
		const cts = parsed.attachments.map((a) => a.contentType);
		// The premise of the enumerated change: the machine-readable part is NOT an
		// attachment per the mailMime predicate (no disposition, no filename).
		expect(cts).not.toContain('message/delivery-status');
	});

	it('recovers message/delivery-status, text/rfc822-headers and message/rfc822 out of the raw MIME', () => {
		const parts = extractReportParts(Buffer.from(DISPOSITIONLESS_DSN));
		const cts = parts.map((p) => p.contentType);
		expect(cts).toContain('message/delivery-status');
		expect(cts).toContain('text/rfc822-headers');
		expect(cts).toContain('message/rfc822');
		// The plain human-readable body leaf is NOT surfaced (it folds into `.text`).
		expect(cts).not.toContain('text/plain');

		const status = parts.find((p) => p.contentType === 'message/delivery-status');
		expect(status?.content.toString('utf-8')).toContain('Status: 5.1.1');
	});

	it('parseBounce classifies the disposition-less DSN off Status: as a hard bounce', () => {
		const parsed = parseMessage(Buffer.from(DISPOSITIONLESS_DSN));
		const parts = extractReportParts(Buffer.from(DISPOSITIONLESS_DSN));
		const result = parseBounce(parsed, parts);
		expect(result).not.toBeNull();
		expect(result?.type).toBe('bounced');
		expect(result?.bounceType).toBe('hard');
		// Attribution came from the recovered returned-message part's X-Owlat header.
		expect(result?.originalMessageId).toBe('<owlat-msg-123@owlat.test>');
	});
});

/**
 * A bounce that returns the original as a `text/plain` ATTACHMENT (disposition
 * attachment / filename) must stay visible to the scrapers — mailparser surfaced
 * such text parts as attachments, and the old `X-Owlat-Message-Id` scan read
 * them. Dropping every text leaf as "body" would lose attribution (finding #4).
 */
const TEXT_PLAIN_ATTACHMENT_BOUNCE = [
	'From: MAILER-DAEMON@mx.example.com',
	'To: sender@example.org',
	'Subject: Delivery Status Notification (Failure)',
	'Date: Fri, 20 Jun 2026 08:15:00 +0000',
	'Message-ID: <dsn-textatt-1@mx.example.com>',
	'MIME-Version: 1.0',
	'Content-Type: multipart/report; report-type=delivery-status; boundary="t1"',
	'',
	'--t1',
	'Content-Type: text/plain; charset=utf-8',
	'',
	'Delivery to the following recipient failed permanently: nobody@example.net',
	'Status: 5.1.1',
	'--t1',
	'Content-Type: text/plain; charset=utf-8',
	'Content-Disposition: attachment; filename="original.txt"',
	'',
	'From: sender@example.org',
	'X-Owlat-Message-Id: <owlat-msg-456@owlat.test>',
	'--t1--',
	'',
].join('\r\n');

describe('a text/plain attachment stays a recoverable report part (finding #4)', () => {
	it('surfaces the text/plain attachment (not dropped as body) so X-Owlat attribution survives', () => {
		const parts = extractReportParts(Buffer.from(TEXT_PLAIN_ATTACHMENT_BOUNCE));
		const textAttachment = parts.find(
			(p) =>
				p.contentType === 'text/plain' && p.content.toString('utf-8').includes('X-Owlat-Message-Id')
		);
		expect(textAttachment).toBeDefined();
		expect(textAttachment?.filename).toBe('original.txt');

		const parsed = parseMessage(Buffer.from(TEXT_PLAIN_ATTACHMENT_BOUNCE));
		const result = parseBounce(parsed, parts);
		expect(result?.originalMessageId).toBe('<owlat-msg-456@owlat.test>');
		expect(result?.bounceType).toBe('hard');
	});
});
