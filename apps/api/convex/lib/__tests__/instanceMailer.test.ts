import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendViaInstanceMta } from '../instanceMailer';
import { isAutomatedMail } from '../inboundClassification';

/**
 * sendViaInstanceMta is the single transport every system / auth / DOI mail
 * uses (password reset, invitation, account-deletion, double opt-in,
 * email-change). RFC 3834 §5: those are machine-generated and must carry
 * `Auto-Submitted: auto-generated` so receiving auto-responders (incl. another
 * Owlat instance) suppress replies and mail loops can't form.
 */

const ORIG_URL = process.env['MTA_API_URL'];
const ORIG_KEY = process.env['MTA_API_KEY'];

function lastFetchBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
	const calls = fetchMock.mock.calls;
	const call = calls[calls.length - 1];
	if (!call) throw new Error('fetch was not called');
	const init = call[1] as RequestInit;
	return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe('sendViaInstanceMta', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		process.env['MTA_API_URL'] = 'https://mta.example.com/';
		process.env['MTA_API_KEY'] = 'test-key';
		fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ success: true }), { status: 200 }),
		);
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (ORIG_URL === undefined) delete process.env['MTA_API_URL'];
		else process.env['MTA_API_URL'] = ORIG_URL;
		if (ORIG_KEY === undefined) delete process.env['MTA_API_KEY'];
		else process.env['MTA_API_KEY'] = ORIG_KEY;
	});

	it('stamps Auto-Submitted: auto-generated on the /send body (RFC 3834 §5)', async () => {
		await sendViaInstanceMta({
			to: 'user@example.com',
			from: 'Owlat <noreply@mail.owlat.app>',
			subject: 'Reset your password',
			html: '<p>Reset link</p>',
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const url = fetchMock.mock.calls[0]?.[0] as string;
		expect(url).toBe('https://mta.example.com/send');

		const body = lastFetchBody(fetchMock);
		const headers = body['headers'] as Record<string, string>;
		expect(headers).toMatchObject({ 'Auto-Submitted': 'auto-generated' });
	});

	it('produces a header set that isAutomatedMail classifies as automated (Owlat-to-Owlat suppression)', async () => {
		await sendViaInstanceMta({
			to: 'user@example.com',
			from: 'noreply@mail.owlat.app',
			subject: 'Confirm your subscription',
			html: '<p>Confirm</p>',
		});

		const body = lastFetchBody(fetchMock);
		const headers = body['headers'] as Record<string, string>;
		expect(isAutomatedMail(headers)).toBe(true);
	});

	// ── PR-43 (Header-injection, RFC 5322 §2.2) ─────────────────────────────
	//
	// sendViaInstanceMta serializes `subject` and `from` straight into the MTA
	// /send JSON body. Producer-side defense-in-depth: a bare CR/LF in either
	// field must be stripped here so it can never split into an injected header
	// (e.g. `Bcc:`) on the wire, independent of the transport.
	it('strips CR/LF from the subject before serializing the /send body', async () => {
		await sendViaInstanceMta({
			to: 'user@example.com',
			from: 'noreply@mail.owlat.app',
			subject: 'Welcome\r\nBcc: x@evil.com',
			html: '<p>x</p>',
		});

		const body = lastFetchBody(fetchMock);
		const subject = body['subject'] as string;
		expect(subject).not.toMatch(/[\r\n]/);
		expect(subject).not.toMatch(/^Bcc:/im);
		expect(subject).toContain('Welcome');
	});

	it('strips CR/LF from the from address before serializing the /send body', async () => {
		await sendViaInstanceMta({
			to: 'user@example.com',
			from: 'noreply@mail.owlat.app\r\nBcc: x@evil.com',
			subject: 'Hello',
			html: '<p>x</p>',
		});

		const body = lastFetchBody(fetchMock);
		const from = body['from'] as string;
		expect(from).not.toMatch(/[\r\n]/);
		expect(from).not.toMatch(/^Bcc:/im);
	});

	it('throws and does not call fetch when the MTA is not configured', async () => {
		delete process.env['MTA_API_URL'];
		delete process.env['MTA_API_KEY'];

		await expect(
			sendViaInstanceMta({
				to: 'user@example.com',
				from: 'noreply@mail.owlat.app',
				subject: 's',
				html: '<p>x</p>',
			}),
		).rejects.toThrow(/not configured/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
