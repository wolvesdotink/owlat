import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';

/**
 * `sendSystemEmail` is the single transport for every system / auth / DOI mail
 * (password reset, invitation, account-deletion, double opt-in, email-change).
 *
 * The MTA branch used to call a dedicated `sendViaInstanceMta` client. It now
 * routes through the shared `sendProviderDispatch` like the resend/ses branches,
 * passing ipPool 'transactional'. These tests lock the byte-for-byte /send body
 * (ipPool 'transactional', dkimDomain defaulted to the from-domain, a random
 * messageId, and the RFC 3834 `Auto-Submitted: auto-generated` header) so the
 * default self-host is provably unchanged, and confirm the provider-health
 * recording path (previously skipped by the dedicated client) now runs.
 */

const modules = import.meta.glob('../**/*.*s');
const originalFetch = global.fetch;

describe('sendSystemEmail — MTA branch routes through sendProviderDispatch', () => {
	beforeEach(() => {
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		vi.stubEnv('MTA_API_URL', 'https://mta.test/');
		vi.stubEnv('MTA_API_KEY', 'test-key');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('POSTs a /send body carrying ipPool "transactional", the Auto-Submitted header, the defaulted dkimDomain, and a random messageId', async () => {
		const t = convexTest(schema, modules);

		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true, id: 'mta-sys-1' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		);
		global.fetch = fetchSpy as unknown as typeof fetch;

		const result = await t.action(internal.systemMail.sendSystemEmail, {
			to: 'user@example.com',
			from: 'Owlat <noreply@mail.example.com>',
			subject: 'Reset your password',
			html: '<p>Reset link</p>',
		});

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const url = fetchSpy.mock.calls[0]![0] as string;
		expect(url).toBe('https://mta.test/send');

		const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
		expect(body.ipPool).toBe('transactional');
		expect(body.to).toBe('user@example.com');
		expect(body.from).toBe('Owlat <noreply@mail.example.com>');
		expect(body.subject).toBe('Reset your password');
		// dkimDomain defaults to the from-address domain (DMARC alignment).
		expect(body.dkimDomain).toBe('mail.example.com');
		// A random messageId is generated when none is supplied.
		expect(typeof body.messageId).toBe('string');
		expect(body.messageId.length).toBeGreaterThan(0);
		// RFC 3834 §5 anti-loop header.
		expect(body.headers).toMatchObject({ 'Auto-Submitted': 'auto-generated' });
		expect(result).toMatchObject({
			provider: 'mta',
			providerMessageId: 'mta-sys-1',
			attempts: 1,
		});
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
	});

	// The provider-health recording path is now shared with resend/ses: the MTA
	// system-mail path goes through `sendProviderDispatch`, whose success- and
	// failure-side `recordSendResult` scheduling is covered end-to-end (including
	// the 'mta' provider) by `lib/sendProviders/__tests__/dispatch.integration.test.ts`.
	// The dedicated `sendViaInstanceMta` client used to skip health recording; it
	// no longer exists.

	it('throws a clear error when the MTA send fails', async () => {
		const t = convexTest(schema, modules);

		global.fetch = vi
			.fn()
			.mockResolvedValue(
				new Response('Invalid recipient address', { status: 400 })
			) as unknown as typeof fetch;

		await expect(
			t.action(internal.systemMail.sendSystemEmail, {
				to: 'bad',
				from: 'noreply@mail.example.com',
				subject: 's',
				html: '<p>x</p>',
			})
		).rejects.toThrow(/System email send failed via mta/);
	});

	it('fail-closed: throws when no transport is configured', async () => {
		vi.stubEnv('EMAIL_PROVIDER', '');
		const t = convexTest(schema, modules);

		await expect(
			t.action(internal.systemMail.sendSystemEmail, {
				to: 'user@example.com',
				from: 'noreply@mail.example.com',
				subject: 's',
				html: '<p>x</p>',
			})
		).rejects.toThrow(/No system email transport configured/);
	});
});
