/**
 * P4-1 (c): a Microsoft JMRP complaint routes through the EXISTING ARF
 * processor.
 *
 * JMRP reports are RFC 5965 ARF, so the shipped parser already owns them —
 * this suite pins that, and pins the one Microsoft-specific gap it had to
 * close: JMRP frequently omits every standard recipient field and carries the
 * complaining address only in `X-HmXmrOriginalRecipient` on the re-attached
 * original message.
 *
 * Attribution to the send is the signed VERP return path, exactly as for every
 * other ISP; the cell and the arm are then derived from that send, so nothing
 * here reads an org, a campaign or an arm out of internet-supplied bytes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { ParsedMessage } from '@owlat/mail-message';
import { tryParseARF } from '../fblProcessor.js';
import { buildVerpAddress } from '../verp.js';
import { reportPartsOf } from './helpers/reportParts.js';

const KEY = 'fbl-verp-key-abcdef0123456789';
const RETURN_PATH_DOMAIN = 'bounces.owlat.test';
const SEND_ID = 'send_microsoftComplaint0001';
const SENDING_IP = '203.0.113.10';

interface MockPart {
	contentType?: string;
	content?: Buffer;
}

function jmrpMessage(parts: {
	feedbackReport: string;
	originalMessage?: string;
	body?: string;
}): ParsedMessage {
	const attachments: MockPart[] = [
		{ contentType: 'message/feedback-report', content: Buffer.from(parts.feedbackReport) },
	];
	if (parts.originalMessage !== undefined) {
		attachments.push({
			contentType: 'message/rfc822',
			content: Buffer.from(parts.originalMessage),
		});
	}
	return {
		text:
			parts.body ??
			'This is an email abuse report for an email message received from IP 203.0.113.10.',
		subject: 'FW: Junk mail report',
		headers: new Map([['content-type', 'multipart/report; report-type=feedback-report']]),
		attachments,
	} as unknown as ParsedMessage;
}

function parse(message: ParsedMessage) {
	return tryParseARF(message, reportPartsOf(message));
}

/** The machine-readable part Microsoft's JMRP actually sends. */
function jmrpFeedbackReport(originalMailFrom: string): string {
	return [
		'Feedback-Type: abuse',
		'User-Agent: Microsoft Junk Mail Reporting Program',
		'Version: 0.1',
		`Original-Mail-From: ${originalMailFrom}`,
		`Source-IP: ${SENDING_IP}`,
		'Reported-Domain: hotmail.com',
		'Arrival-Date: Mon, 20 Jul 2026 09:14:02 +0000',
	].join('\r\n');
}

describe('Microsoft JMRP complaints through the shipped ARF processor', () => {
	beforeEach(() => {
		process.env['BOUNCE_VERP_KEY'] = KEY;
	});

	afterEach(() => {
		delete process.env['BOUNCE_VERP_KEY'];
	});

	it('classifies the report, attributes the send and identifies Microsoft', () => {
		const result = parse(
			jmrpMessage({
				feedbackReport: jmrpFeedbackReport(buildVerpAddress(SEND_ID, RETURN_PATH_DOMAIN, KEY)),
				originalMessage: [
					'X-HmXmrOriginalRecipient: subscriber@hotmail.com',
					'From: news@example.test',
					'Subject: This week at Example',
				].join('\r\n'),
			})
		);

		expect(result).not.toBeNull();
		expect(result?.type).toBe('complained');
		expect(result?.bounceType).toBe('hard');
		expect(result?.feedbackType).toBe('abuse');
		// The send — and therefore its cell and arm — comes from the signed VERP.
		expect(result?.originalMessageId).toBe(SEND_ID);
		// The recipient comes from the Microsoft-specific header, because JMRP
		// emitted no RFC 5965 recipient field at all.
		expect(result?.recipient).toBe('subscriber@hotmail.com');
		expect(result?.sourceIsp).toBe('microsoft');
		expect(result?.reportedDomain).toBe('hotmail.com');
		expect(result?.sourceIp).toBe(SENDING_IP);
		// reduceFbl() re-extracts the ISP from this text with /from (\w+)/.
		expect(result?.message).toBe('Spam complaint via ARF from microsoft');
	});

	it('prefers the RFC 5965 recipient field when the report carries one', () => {
		const result = parse(
			jmrpMessage({
				feedbackReport: [
					jmrpFeedbackReport(buildVerpAddress(SEND_ID, RETURN_PATH_DOMAIN, KEY)),
					'Original-Rcpt-To: <standard@hotmail.com>',
				].join('\r\n'),
				originalMessage: 'X-HmXmrOriginalRecipient: microsoft-only@hotmail.com',
			})
		);

		expect(result?.recipient).toBe('standard@hotmail.com');
	});

	it('still recognises a JMRP report that reaches us inline, with no typed part', () => {
		const inline = {
			text: [
				jmrpFeedbackReport(buildVerpAddress(SEND_ID, RETURN_PATH_DOMAIN, KEY)),
				'',
				'X-HmXmrOriginalRecipient: inline@hotmail.com',
			].join('\r\n'),
			subject: 'Junk mail report',
			headers: new Map([['content-type', 'text/plain']]),
			attachments: [],
		} as unknown as ParsedMessage;

		const result = parse(inline);
		expect(result?.type).toBe('complained');
		expect(result?.originalMessageId).toBe(SEND_ID);
		expect(result?.recipient).toBe('inline@hotmail.com');
		expect(result?.sourceIsp).toBe('microsoft');
	});

	it('refuses attribution from a forged report and never reads an org from it', () => {
		const forgedVerp = `bounce+${Buffer.from(SEND_ID).toString('base64url')}@${RETURN_PATH_DOMAIN}`;
		const result = parse(
			jmrpMessage({
				feedbackReport: jmrpFeedbackReport(forgedVerp),
				originalMessage: [
					'X-Owlat-Org-Id: org-99',
					`X-Owlat-Message-Id: ${SEND_ID}`,
					'X-HmXmrOriginalRecipient: victim@hotmail.com',
				].join('\r\n'),
			})
		);

		// Still a complaint worth counting, but with NO attributable send: an
		// unsigned VERP token must not let a forged report suppress a recipient's
		// mail or charge a complaint to someone else's cell.
		expect(result?.type).toBe('complained');
		expect(result?.originalMessageId).toBeUndefined();
		expect(result?.organizationId).toBeUndefined();
	});

	it('tolerates a JMRP report with no recipient anywhere', () => {
		const result = parse(
			jmrpMessage({
				feedbackReport: jmrpFeedbackReport(buildVerpAddress(SEND_ID, RETURN_PATH_DOMAIN, KEY)),
			})
		);

		expect(result?.type).toBe('complained');
		expect(result?.originalMessageId).toBe(SEND_ID);
		expect(result?.recipient).toBeUndefined();
	});
});
