/**
 * Forwarding remail: Reply-To preservation.
 *
 * `runPostDelivery` forwards inbound mail by re-originating it under the
 * mailbox's own domain (from = mailbox address, DKIM signed under the
 * mailbox's domain) so the outbound hop passes SPF/DKIM. That is a legitimate
 * non-ARC remail (RFC 7960) — but it drops the original sender from the From
 * line. Without a Reply-To pointing back at the original sender, any reply to
 * the forwarded copy lands on the forwarding mailbox instead of the person who
 * actually wrote the message.
 *
 * Regression guard: the captured /send body must set `from` to the mailbox
 * address, `dkimDomain` to the mailbox's domain, AND `replyTo` to the original
 * sender. The Reply-To assertion fails before the fix.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	forwardToTarget,
	shouldAutoReply,
	autoReplyRecipient,
	autoReplyThreadingHeaders,
} from '../deliveryHooks';

afterEach(() => {
	vi.restoreAllMocks();
});

interface SendBody {
	from: string;
	to: string;
	subject: string;
	html: string;
	text?: string;
	replyTo?: string;
	dkimDomain: string;
	headers: Record<string, string>;
}

function captureSend() {
	const calls: Array<{ url: string; body: SendBody }> = [];
	const fetchSpy = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (url, init) => {
			calls.push({
				url: String(url),
				body: JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')) as SendBody,
			});
			return new Response('{}', { status: 200 });
		});
	return { calls, fetchSpy };
}

describe('forwardToTarget', () => {
	const mta = { baseUrl: 'https://mta.test', apiKey: 'secret' };
	const baseArgs = {
		mailboxId: 'mailbox1',
		mailboxAddress: 'me@owlat.test',
		fromAddress: 'alice@external.example',
		subject: 'Hello',
		bodyText: 'plain body',
		bodyHtml: '<p>hi</p>',
	};

	it('re-originates under the mailbox domain and sets Reply-To to the original sender', async () => {
		const { calls } = captureSend();

		await forwardToTarget(mta, baseArgs, 'forward-target@elsewhere.example');

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe('https://mta.test/send');
		const body = calls[0]!.body;

		// Re-originated under the mailbox so the outbound DKIM/SPF check passes.
		expect(body.from).toBe('me@owlat.test');
		expect(body.dkimDomain).toBe('owlat.test');

		// The original sender must remain reachable via Reply-To (the fix).
		expect(body.replyTo).toBe('alice@external.example');

		// Original sender is also preserved in the trace header.
		expect(body.headers['X-Owlat-Forwarded-From']).toBe('alice@external.example');
		expect(body.to).toBe('forward-target@elsewhere.example');
		expect(body.subject).toBe('Fwd: Hello');
	});

	it('strips scripts from the forwarded HTML body', async () => {
		const { calls } = captureSend();

		await forwardToTarget(
			mta,
			{ ...baseArgs, bodyHtml: '<p>ok</p><script>alert(1)</script>' },
			'forward-target@elsewhere.example',
		);

		const body = calls[0]!.body;
		expect(body.html).not.toContain('<script>');
		expect(body.html).toContain('ok');
	});
});

/**
 * PR-45: vacation auto-reply must be suppressed for bounces / DSNs. The loop
 * guard keys off the SMTP *envelope* return-path (RFC 5321 §4.5.5 MAIL FROM),
 * never the spoofable `From:` header. A DSN arrives with `From: MAILER-DAEMON`
 * and no `Auto-Submitted` header, so `isAutomatedMail` does NOT catch it — only
 * the null-return-path check stops the backscatter (RFC 3834 §2).
 */
describe('shouldAutoReply', () => {
	const base = {
		fromAddress: 'alice@external.example',
		mailboxAddress: 'me@owlat.test',
		returnPath: 'alice@external.example',
		headers: {} as Record<string, string>,
	};

	it('allows a normal inbound message with a real envelope sender', () => {
		expect(shouldAutoReply(base)).toBe(true);
	});

	it('suppresses a DSN: null envelope return-path even though From is MAILER-DAEMON', () => {
		expect(
			shouldAutoReply({
				...base,
				// Spoofable header says a human-ish daemon; envelope says <>.
				fromAddress: 'MAILER-DAEMON@mx.isp.example',
				returnPath: '',
			}),
		).toBe(false);
	});

	it('suppresses when the envelope return-path is whitespace-only', () => {
		expect(shouldAutoReply({ ...base, returnPath: '   ' })).toBe(false);
	});

	it('suppresses when there is no From address to reply to', () => {
		expect(shouldAutoReply({ ...base, fromAddress: '' })).toBe(false);
	});

	it('suppresses a self-send (sender == mailbox)', () => {
		expect(
			shouldAutoReply({ ...base, fromAddress: 'ME@owlat.test', returnPath: 'me@owlat.test' }),
		).toBe(false);
	});

	it('suppresses automated mail flagged by Auto-Submitted (RFC 3834 §3)', () => {
		expect(
			shouldAutoReply({ ...base, headers: { 'Auto-Submitted': 'auto-replied' } }),
		).toBe(false);
	});

	it('suppresses mailing-list traffic flagged by List-Id', () => {
		expect(shouldAutoReply({ ...base, headers: { 'List-Id': '<list.example>' } })).toBe(false);
	});

	it('does NOT suppress on a legacy build where returnPath is absent (undefined)', () => {
		// Distinguishes "no envelope threaded" (undefined) from "null sender" ('').
		const { returnPath: _omit, ...withoutReturnPath } = base;
		expect(shouldAutoReply(withoutReturnPath)).toBe(true);
	});
});

/**
 * PR-47: a vacation auto-reply must go to the envelope return-path (RFC 3834 §4),
 * not the spoofable `From:` header, and must thread onto the triggering message
 * (RFC 3834 §3.1.5 In-Reply-To / §3.1.6 References, RFC 5322 §3.6.4).
 */
describe('autoReplyRecipient', () => {
	it('uses the envelope return-path when present (RFC 3834 §4)', () => {
		expect(
			autoReplyRecipient({
				fromAddress: 'alice-display@isp.example',
				returnPath: 'bounce+alice@isp.example',
			}),
		).toBe('bounce+alice@isp.example');
	});

	it('lower-cases the chosen recipient', () => {
		expect(
			autoReplyRecipient({ fromAddress: 'X@isp.example', returnPath: 'Bounce@ISP.example' }),
		).toBe('bounce@isp.example');
	});

	it('falls back to the From header when the envelope was not threaded (undefined)', () => {
		expect(autoReplyRecipient({ fromAddress: 'Carol@isp.example' })).toBe('carol@isp.example');
	});

	it('falls back to the From header on a whitespace-only return-path', () => {
		expect(
			autoReplyRecipient({ fromAddress: 'carol@isp.example', returnPath: '   ' }),
		).toBe('carol@isp.example');
	});
});

describe('autoReplyThreadingHeaders', () => {
	it('sets In-Reply-To and References to the triggering Message-Id', () => {
		expect(
			autoReplyThreadingHeaders({ triggeringMessageId: '<original-msg-id@host>' }),
		).toEqual({
			'In-Reply-To': '<original-msg-id@host>',
			References: '<original-msg-id@host>',
		});
	});

	it('prepends the prior References chain ahead of the triggering Message-Id', () => {
		expect(
			autoReplyThreadingHeaders({
				triggeringMessageId: '<msg-2@host>',
				triggeringReferences: '<root@host> <msg-1@host>',
			}),
		).toEqual({
			'In-Reply-To': '<msg-2@host>',
			References: '<root@host> <msg-1@host> <msg-2@host>',
		});
	});

	it('returns no threading headers when there is no triggering Message-Id', () => {
		expect(autoReplyThreadingHeaders({})).toEqual({});
		expect(autoReplyThreadingHeaders({ triggeringMessageId: '   ' })).toEqual({});
	});
});
