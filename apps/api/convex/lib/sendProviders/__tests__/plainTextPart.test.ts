/**
 * Every core adapter puts the Send's plain-text part on the wire.
 *
 * A governed send carries `text`: the author's plain-text version, or a strip
 * of the UNTRACKED html, so it holds no redirect links. Resend used to drop it
 * (Resend then derived its own text from the tracked html) and SES only ever
 * emitted a `text/html` part. This table drives each core adapter against a
 * stub of its wire (fetch, the Resend SDK, the AWS SDK, the SMTP client) with
 * `text: 'PLAIN-X'` and an html body that does not contain that string, and
 * reads PLAIN-X back from what the stub captured. For the adapters that send
 * raw MIME (SES, Mandrill, SMTP) it parses the message and checks the
 * `text/plain` part itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CORE_SEND_PROVIDER_CATALOG_ENTRIES } from '@owlat/shared';
import { parseMessage } from '@owlat/mail-message';
import { SEND_ACCEPTED_BYTES } from '@owlat/mta-protocol/wireFixtures';
import { mtaSendProvider } from '../mta';
import { sesSendProvider, _resetSesClientCacheForTests } from '../ses';
import { resendSendProvider, _resetResendClientCacheForTests } from '../resend';
import { smtpSendProvider, _resetSmtpConfigCacheForTests } from '../smtp';
import { mandrillSendProvider, _resetMandrillConfigCacheForTests } from '../mandrill';
import { emailitSendProvider } from '../emailit';
import { resolveSendTransport, _resetSendTransportCacheForTests } from '../transports';
import type { CoreSendProviderKind, EmailSendAttempt, EmailSendParams } from '../types';

const { resendSend, sesSend, smtpSendMessage } = vi.hoisted(() => ({
	resendSend: vi.fn(),
	sesSend: vi.fn(),
	smtpSendMessage: vi.fn(),
}));

vi.mock('resend', () => ({
	Resend: class {
		emails = { send: resendSend };
	},
}));

vi.mock('@aws-sdk/client-ses', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	SESClient: class {
		send = sesSend;
	},
}));

vi.mock('@owlat/smtp-client', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	sendMessage: smtpSendMessage,
}));

const PLAIN = 'PLAIN-X';

const params: EmailSendParams = {
	to: 'to@example.com',
	from: 'Acme <from@acme.test>',
	subject: 'Plain-text part',
	html: '<p>HTML only <a href="https://acme.test/t/c/abc">tracked</a></p>',
	text: PLAIN,
};

const originalFetch = global.fetch;
let fetchBodies: string[] = [];

function stubFetch(respond: () => Response): void {
	global.fetch = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
		fetchBodies.push(String(init?.body ?? ''));
		return respond();
	}) as unknown as typeof fetch;
}

function lastFetchJson(): Record<string, unknown> {
	return JSON.parse(fetchBodies[fetchBodies.length - 1]!) as Record<string, unknown>;
}

/** The `text/plain` body of a raw MIME message, decoded by the real parser. */
function plainTextOf(raw: string | Uint8Array): string | undefined {
	return parseMessage(typeof raw === 'string' ? raw : Buffer.from(raw)).text;
}

interface WireCase {
	/** Send through the adapter with the wire stubbed. */
	send(): Promise<EmailSendAttempt>;
	/** Read the plain-text part back from what the stub captured. */
	capturedText(): string | undefined;
}

const cases: Record<CoreSendProviderKind, WireCase> = {
	mta: {
		send: () => {
			stubFetch(() => new Response(SEND_ACCEPTED_BYTES, { status: 200 }));
			return mtaSendProvider.sendEmail(resolveSendTransport('mta'), params);
		},
		capturedText: () => lastFetchJson()['text'] as string | undefined,
	},
	emailit: {
		send: () => {
			stubFetch(() => new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }));
			return emailitSendProvider.sendEmail(resolveSendTransport('emailit'), params);
		},
		capturedText: () => lastFetchJson()['text'] as string | undefined,
	},
	mandrill: {
		send: () => {
			stubFetch(
				() =>
					new Response(JSON.stringify([{ email: 'to@example.com', status: 'sent', _id: 'md_1' }]), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					})
			);
			return mandrillSendProvider.sendEmail(resolveSendTransport('mandrill'), params);
		},
		capturedText: () => plainTextOf(lastFetchJson()['raw_message'] as string),
	},
	resend: {
		send: () => {
			resendSend.mockResolvedValue({ data: { id: 're_1' }, error: null });
			return resendSendProvider.sendEmail(resolveSendTransport('resend'), params);
		},
		capturedText: () => (resendSend.mock.calls[0]![0] as { text?: string }).text,
	},
	ses: {
		send: () => {
			sesSend.mockResolvedValue({ MessageId: 'ses_1' });
			return sesSendProvider.sendEmail(resolveSendTransport('ses'), params);
		},
		capturedText: () => {
			const command = sesSend.mock.calls[0]![0] as { input: { RawMessage: { Data: Uint8Array } } };
			return plainTextOf(command.input.RawMessage.Data);
		},
	},
	smtp: {
		send: () => {
			smtpSendMessage.mockResolvedValue(undefined);
			return smtpSendProvider.sendEmail(resolveSendTransport('smtp'), params);
		},
		capturedText: () => {
			const call = smtpSendMessage.mock.calls[0]![0] as { envelope: { data: Buffer } };
			return plainTextOf(call.envelope.data);
		},
	},
};

beforeEach(() => {
	fetchBodies = [];
	resendSend.mockReset();
	sesSend.mockReset();
	smtpSendMessage.mockReset();
	_resetSendTransportCacheForTests();
	_resetSesClientCacheForTests();
	_resetResendClientCacheForTests();
	_resetSmtpConfigCacheForTests();
	_resetMandrillConfigCacheForTests();
	vi.stubEnv('MTA_API_URL', 'https://mta.test');
	vi.stubEnv('MTA_API_KEY', 'mta-test-key');
	vi.stubEnv('EMAILIT_API_KEY', 'emailit-test-key');
	vi.stubEnv('MANDRILL_API_KEY', 'md-test-key');
	vi.stubEnv('RESEND_API_KEY', 're_test_key');
	vi.stubEnv('AWS_SES_REGION', 'us-east-1');
	vi.stubEnv('AWS_SES_ACCESS_KEY_ID', 'AKIATEST');
	vi.stubEnv('AWS_SES_SECRET_ACCESS_KEY', 'secret');
	vi.stubEnv('SMTP_RELAY_HOST', 'relay.example.net');
	vi.stubEnv('SMTP_RELAY_USERNAME', 'user');
	vi.stubEnv('SMTP_RELAY_PASSWORD', 'pass');
	vi.stubEnv('EHLO_HOSTNAME', 'mail.example.com');
});

afterEach(() => {
	vi.unstubAllEnvs();
	global.fetch = originalFetch;
	_resetSendTransportCacheForTests();
	_resetSesClientCacheForTests();
	_resetResendClientCacheForTests();
	_resetSmtpConfigCacheForTests();
	_resetMandrillConfigCacheForTests();
});

describe('the plain-text part reaches the wire on every core adapter', () => {
	it('covers every core send provider kind', () => {
		expect(Object.keys(cases).sort()).toEqual(
			CORE_SEND_PROVIDER_CATALOG_ENTRIES.map((entry) => entry.kind).sort()
		);
	});

	it.each(Object.keys(cases) as CoreSendProviderKind[])('%s', async (kind) => {
		const attempt = await cases[kind].send();
		if (!attempt.success) throw new Error(`${kind} send failed: ${attempt.errorMessage}`);
		expect(cases[kind].capturedText()?.trim()).toBe(PLAIN);
	});
});
