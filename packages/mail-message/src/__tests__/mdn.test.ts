import { describe, it, expect } from 'vitest';
import {
	isDispositionNotificationReport,
	parseDispositionNotification,
	readDispositionNotificationTo,
} from '../parse/mdn';
import { buildDispositionNotification } from '../compose/mdn';
import { parseHeaders } from '../parse/headers';

const eml = (...lines: string[]): string => lines.join('\r\n');

/** A receipt as Thunderbird sends one, with the fields part swappable. */
function receipt(fields: string[], contentType = 'message/disposition-notification'): string {
	return eml(
		'From: Ben <ben@example.com>',
		'To: ada@example.org',
		'Subject: Read: Quarterly numbers',
		'MIME-Version: 1.0',
		'Content-Type: multipart/report; report-type="disposition-notification";',
		' boundary="RCPT"',
		'',
		'--RCPT',
		'Content-Type: text/plain; charset=UTF-8',
		'',
		'This is a receipt for the mail you sent to ben@example.com.',
		'',
		'--RCPT',
		`Content-Type: ${contentType}`,
		'',
		...fields,
		'',
		'--RCPT--',
		''
	);
}

const DISPLAYED = [
	'Reporting-UA: mail.example.com; Thunderbird',
	'Final-Recipient: rfc822;Ben@Example.com',
	'Original-Message-ID: <m1.abc@example.org>',
	'Disposition: manual-action/MDN-sent-manually; displayed',
];

describe('parseDispositionNotification', () => {
	it('reads the original message id, the recipient and the disposition', () => {
		expect(parseDispositionNotification(receipt(DISPLAYED))).toEqual({
			originalMessageId: 'm1.abc@example.org',
			finalRecipient: 'ben@example.com',
			disposition: 'displayed',
			isAutomatic: false,
		});
	});

	it('marks a receipt the recipient did not choose to send as automatic', () => {
		const fields = [
			'Original-Message-ID: <m1.abc@example.org>',
			'Disposition: automatic-action/MDN-sent-automatically; deleted',
		];
		expect(parseDispositionNotification(receipt(fields))).toEqual({
			originalMessageId: 'm1.abc@example.org',
			disposition: 'deleted',
			isAutomatic: true,
		});
	});

	it('reads a base64-encoded notification part', () => {
		const encoded = Buffer.from(DISPLAYED.join('\r\n')).toString('base64');
		const raw = receipt(
			[encoded],
			'message/disposition-notification\r\nContent-Transfer-Encoding: base64'
		);
		expect(parseDispositionNotification(raw)?.originalMessageId).toBe('m1.abc@example.org');
	});

	it('ignores a delivery-status report', () => {
		const raw = receipt(DISPLAYED).replace(
			'report-type="disposition-notification"',
			'report-type="delivery-status"'
		);
		expect(parseDispositionNotification(raw)).toBeNull();
	});

	it('ignores a report without an original message id', () => {
		expect(parseDispositionNotification(receipt(DISPLAYED.slice(0, 2).concat(DISPLAYED[3]!)))).toBe(
			null
		);
	});

	it('ignores an unknown disposition type', () => {
		const fields = [...DISPLAYED.slice(0, 3), 'Disposition: manual-action/MDN-sent-manually; read'];
		expect(parseDispositionNotification(receipt(fields))).toBeNull();
	});

	it('ignores ordinary mail', () => {
		const raw = eml('From: ben@example.com', 'Subject: hi', '', 'Disposition: x; displayed', '');
		expect(parseDispositionNotification(raw)).toBeNull();
	});
});

describe('isDispositionNotificationReport', () => {
	it('matches the report type case-insensitively', () => {
		expect(
			isDispositionNotificationReport(
				'Multipart/Report; report-type=Disposition-Notification; boundary=x'
			)
		).toBe(true);
	});

	it('rejects other content types and a missing header', () => {
		expect(isDispositionNotificationReport('multipart/mixed; boundary=x')).toBe(false);
		expect(isDispositionNotificationReport(undefined)).toBe(false);
	});
});

describe('readDispositionNotificationTo', () => {
	it('reads the one address a request names, lowercased', () => {
		expect(readDispositionNotificationTo('Ada <Ada@Example.org>')).toBe('ada@example.org');
		expect(readDispositionNotificationTo('ada@example.org')).toBe('ada@example.org');
	});

	it('keeps no request for several addresses, a group or garbage', () => {
		expect(readDispositionNotificationTo('a@example.org, b@example.org')).toBeUndefined();
		expect(readDispositionNotificationTo('team: a@example.org;')).toBeUndefined();
		expect(readDispositionNotificationTo('not an address')).toBeUndefined();
		expect(readDispositionNotificationTo(undefined)).toBeUndefined();
	});
});

describe('buildDispositionNotification', () => {
	const base = {
		from: 'Ben <ben@example.com>',
		to: 'ada@example.org',
		originalSubject: 'Quarterly numbers',
		originalMessageId: 'm1.abc@example.org',
		messageId: '<mdn1@example.com>',
		reportingUa: 'Owlat',
		date: new Date(Date.UTC(2026, 10, 6, 9, 30)),
		boundary: 'MDN-BOUNDARY',
	};

	it('round-trips a manual receipt through the parser', () => {
		const raw = buildDispositionNotification({ ...base, mode: 'manual' }).raw.toString('binary');
		expect(parseDispositionNotification(raw)).toEqual({
			originalMessageId: 'm1.abc@example.org',
			finalRecipient: 'ben@example.com',
			disposition: 'displayed',
			isAutomatic: false,
		});
	});

	it('round-trips an automatic receipt and marks it auto-submitted', () => {
		const raw = buildDispositionNotification({ ...base, mode: 'automatic' }).raw.toString('binary');
		expect(parseDispositionNotification(raw)?.isAutomatic).toBe(true);
		const headers = parseHeaders(raw.split('\r\n\r\n', 1)[0]!);
		expect(headers.get('auto-submitted')).toBe('auto-replied');
	});

	it('addresses the request, threads onto the original and names the report type', () => {
		const raw = buildDispositionNotification({ ...base, mode: 'manual' }).raw.toString('binary');
		const headers = parseHeaders(raw.split('\r\n\r\n', 1)[0]!);
		expect(headers.get('to')).toBe('ada@example.org');
		expect(headers.get('subject')).toBe('Read: Quarterly numbers');
		expect(headers.get('in-reply-to')).toBe('<m1.abc@example.org>');
		expect(headers.get('auto-submitted')).toBeUndefined();
		expect(isDispositionNotificationReport(headers.get('content-type'))).toBe(true);
	});
});
