import { describe, it, expect } from 'vitest';
import { composeCampaign } from '../campaign';

/**
 * Regression-lock for the per-call-site escape policy of the campaign composer
 * (audit: "campaign body HTML-escaped, header-safe subject"). The two call
 * sites in campaign/index.ts deliberately differ:
 *
 *   - htmlContent is personalized with { escape: 'html' } — values go into an
 *     HTML body, so an untrusted firstName/lastName MUST be HTML-escaped to
 *     prevent stored HTML / phishing injection (OWASP XSS).
 *   - subject is personalized with { escape: 'header' } — the subject is a mail
 *     header that email clients render as text, so HTML-escaping it would leak
 *     literal entity strings (e.g. "&lt;b&gt;") into the recipient's inbox; the
 *     header policy still strips CR/LF so a hostile value cannot inject a second
 *     header (RFC 5322 §2.2). CRLF stripping is asserted in subjectCrlf.test.ts.
 *
 * If either call site silently flips its escape policy, these tests fail.
 */
describe('composeCampaign — HTML escape policy (body escaped, subject header-safe)', () => {
	it('HTML body escapes a hostile firstName (no live <script>)', () => {
		const out = composeCampaign({
			kind: 'campaign',
			template: { subject: 'Newsletter', htmlContent: '<p>{{firstName}}</p>' },
			contactInfo: { email: 'a@b.com', firstName: '<script>x</script>' },
		});

		expect(out.html).toBe('<p>&lt;script&gt;x&lt;/script&gt;</p>');
		expect(out.html).toContain('&lt;script&gt;');
		expect(out.html).not.toContain('<script>');
	});

	it('subject is NOT HTML-escaped (a header rendered as text)', () => {
		const out = composeCampaign({
			kind: 'campaign',
			template: { subject: 'Hi {{firstName}}', htmlContent: '<p>x</p>' },
			contactInfo: { email: 'a@b.com', firstName: '<b>' },
		});

		// The raw value passes through verbatim — no &lt;b&gt; entity leakage.
		expect(out.subject).toBe('Hi <b>');
		expect(out.subject).not.toContain('&lt;');
	});

	it('both policies hold simultaneously for the same hostile value', () => {
		const out = composeCampaign({
			kind: 'campaign',
			template: { subject: 'Hi {{firstName}}', htmlContent: '<p>{{firstName}}</p>' },
			contactInfo: { email: 'a@b.com', firstName: '<b>' },
		});

		expect(out.subject).toBe('Hi <b>'); // header: plain
		expect(out.html).toBe('<p>&lt;b&gt;</p>'); // body: escaped
	});
});
