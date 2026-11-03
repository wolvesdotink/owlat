import { describe, it, expect } from 'vitest';
import { isDispositionNotificationReport, parseDispositionNotification } from '../parse/mdn';

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
