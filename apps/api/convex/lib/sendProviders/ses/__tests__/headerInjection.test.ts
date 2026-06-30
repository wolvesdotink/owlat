import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sesSendProvider, _resetSesClientCacheForTests } from '../index';

// Capture the raw bytes handed to SES so we can decode the MIME message and
// assert that no attacker-influenced value smuggled an extra header line.
// `SendRawEmailCommand` is a thin DTO — we record its constructor input and
// have the mocked `SESClient.send` return a fixed MessageId.
const { sendMock, lastRawEmailInput } = vi.hoisted(() => ({
	sendMock: vi.fn().mockResolvedValue({ MessageId: 'ses-msg-1' }),
	lastRawEmailInput: { current: undefined as unknown },
}));

vi.mock('@aws-sdk/client-ses', () => ({
	SESClient: class {
		send = sendMock;
	},
	SendEmailCommand: class {
		input: unknown;
		constructor(input: unknown) {
			this.input = input;
		}
	},
	SendRawEmailCommand: class {
		input: unknown;
		constructor(input: unknown) {
			this.input = input;
			lastRawEmailInput.current = input;
		}
	},
}));

/**
 * Decode the captured raw message and return just the top-level header block
 * (everything before the first blank line). RFC 5322 separates the header
 * section from the body with an empty line.
 */
function capturedHeaderBlock(): string {
	const input = lastRawEmailInput.current as { RawMessage: { Data: Uint8Array } };
	const raw = Buffer.from(input.RawMessage.Data).toString('utf-8');
	return raw.split(/\r\n\r\n/)[0]!;
}

/** Decode the full captured raw message. */
function capturedRaw(): string {
	const input = lastRawEmailInput.current as { RawMessage: { Data: Uint8Array } };
	return Buffer.from(input.RawMessage.Data).toString('utf-8');
}

describe('SES raw-MIME header injection', () => {
	beforeEach(() => {
		_resetSesClientCacheForTests();
		sendMock.mockClear();
		lastRawEmailInput.current = undefined;
		// resolveSesClient requires these three vars; the SESClient itself is mocked.
		vi.stubEnv('AWS_SES_REGION', 'us-east-1');
		vi.stubEnv('AWS_SES_ACCESS_KEY_ID', 'AKIA_TEST');
		vi.stubEnv('AWS_SES_SECRET_ACCESS_KEY', 'secret-test');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		_resetSesClientCacheForTests();
	});

	it('strips CRLF-smuggled headers from attachment filename, reply-to, and custom headers', async () => {
		const result = await sesSendProvider.sendEmail({
			to: 'to@example.com',
			from: 'from@example.com',
			subject: 'hello',
			html: '<p>hi</p>',
			replyTo: 'rt@b.com\r\nBcc: rt2@evil.com',
			headers: { 'X-Custom': 'ok\r\nBcc: hdr@evil.com' },
			attachments: [
				{
					filename: 'evil.pdf"\r\nBcc: victim@attacker.test\r\nX-Injected: 1"',
					content: Buffer.from('fake-pdf-bytes'),
					contentType: 'application/pdf',
				},
			],
		});

		expect(result).toEqual({ success: true, id: 'ses-msg-1' });
		expect(sendMock).toHaveBeenCalledTimes(1);

		const raw = capturedRaw();

		// No smuggled Bcc header line may appear anywhere in the message, and no
		// injected X-Injected header line may exist.
		expect(raw).not.toMatch(/^Bcc:/im);
		expect(raw).not.toMatch(/^X-Injected:/im);

		// The Content-Disposition filename param must not contain a raw CR/LF.
		const dispositionLine = raw
			.split(/\r\n/)
			.find((line) => /^Content-Disposition:/i.test(line));
		expect(dispositionLine).toBeDefined();
		expect(dispositionLine).not.toMatch(/[\r\n]/);

		// The legitimate top-level headers survive.
		const headerBlock = capturedHeaderBlock();
		expect(headerBlock).toMatch(/^From: from@example\.com$/im);
		expect(headerBlock).toMatch(/^To: to@example\.com$/im);
	});

	it('preserves a benign attachment filename intact', async () => {
		await sesSendProvider.sendEmail({
			to: 'to@example.com',
			from: 'from@example.com',
			subject: 'hello',
			html: '<p>hi</p>',
			attachments: [
				{
					filename: 'report.pdf',
					content: Buffer.from('bytes'),
					contentType: 'application/pdf',
				},
			],
		});

		const raw = capturedRaw();
		expect(raw).toMatch(/Content-Disposition: attachment; filename="report\.pdf"/);
	});
});
