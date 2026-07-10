import { describe, it, expect } from 'vitest';
import {
	renderSystemEmail,
	generateInvitationEmailHtml,
	generatePasswordResetEmailHtml,
	generateChangeEmailVerificationHtml,
	generateNewEmailVerificationHtml,
	generateDeletionEmailHtml,
	generateConfirmationEmailHtml,
} from '../systemEmails';

describe('renderSystemEmail', () => {
	it('wraps the body in the shared dark-theme chrome with title + footer', () => {
		const html = renderSystemEmail({ title: 'T', body: '              <p>hi</p>', footer: 'F' });
		expect(html).toContain('<title>T</title>');
		expect(html).toContain('background-color: #12110e'); // body bg
		expect(html).toContain('background-color: #1a1816'); // card bg
		expect(html).toContain('              <p>hi</p>');
		expect(html).toContain('                F\n');
	});

	it('defaults the footer to "Sent by Owlat"', () => {
		expect(renderSystemEmail({ title: 'T', body: 'x' })).toContain('Sent by Owlat');
	});
});

describe('system email generators', () => {
	it('invitation escapes interpolated values and sets the title', () => {
		const html = generateInvitationEmailHtml(
			'Acme & Co',
			"O'Brien",
			'o@acme.com',
			'https://x/a',
			'admin'
		);
		expect(html).toContain("<title>You're invited to join Acme &amp; Co</title>");
		expect(html).toContain('O&#39;Brien');
		expect(html).toContain('Accept Invitation');
		expect(html).toContain('as an <strong style="color: #c4785a;">Admin</strong>');
	});

	it('invitation maps the BetterAuth "member" wire role to the "Editor" app label', () => {
		const html = generateInvitationEmailHtml('Acme', 'Sam', 's@acme.com', 'https://x/a', 'member');
		expect(html).toContain('as an <strong style="color: #c4785a;">Editor</strong>');
		expect(html).not.toContain('Member');
	});

	it('password reset escapes the name', () => {
		const html = generatePasswordResetEmailHtml('Jo <test>', 'https://x/r');
		expect(html).toContain('Hi Jo &lt;test&gt;');
		expect(html).toContain('Reset Password');
	});

	it('change-email (step 1, current address) escapes the name + new address and sets the approve CTA', () => {
		const html = generateChangeEmailVerificationHtml('Jo <test>', 'new&addr@x.com', 'https://x/v');
		expect(html).toContain('<title>Confirm your new email</title>');
		expect(html).toContain('Hi Jo &lt;test&gt;');
		expect(html).toContain('new&amp;addr@x.com');
		expect(html).toContain('Approve email change');
		expect(html).toContain('https://x/v');
	});

	it('new-email verification (step 2, new address) escapes the name + new address and sets the verify CTA', () => {
		const html = generateNewEmailVerificationHtml('Jo <test>', 'new&addr@x.com', 'https://x/v2');
		expect(html).toContain('<title>Verify your new login email</title>');
		expect(html).toContain('Hi Jo &lt;test&gt;');
		expect(html).toContain('new&amp;addr@x.com');
		expect(html).toContain('Verify new email');
		expect(html).toContain('https://x/v2');
	});

	it('deletion uses the automated-email footer + cancel CTA', () => {
		const html = generateDeletionEmailHtml('u@x.com', 'Monday', 'https://x/c');
		expect(html).toContain('This is an automated email from Owlat');
		expect(html).toContain('Cancel Account Deletion');
		expect(html).toContain('Account Deletion Scheduled');
	});

	// The shared ctaWithFallback() helper (private) renders the CTA button AND
	// the verbatim "Or copy and paste this link…" fallback. Assert both halves —
	// the button label/href and the fallback paragraph with the bare URL — land
	// in a generated email so the extraction can't silently drop the fallback.
	it('renders the CTA button and the copy/paste link fallback for the same URL', () => {
		const html = generatePasswordResetEmailHtml('Jo', 'https://x/reset?t=42');
		// Button: the styled <a> carrying the label.
		expect(html).toContain(
			'<a href="https://x/reset?t=42" style="display: inline-block; padding: 14px 32px;'
		);
		expect(html).toContain('Reset Password');
		// Fallback: the verbatim instruction + the bare URL rendered as a link.
		expect(html).toContain('Or copy and paste this link into your browser:');
		expect(html).toContain(
			'<a href="https://x/reset?t=42" style="color: #c4785a; text-decoration: underline;">'
		);
		// The URL appears twice (button href + fallback href + fallback text).
		expect(html.split('https://x/reset?t=42').length - 1).toBe(3);
	});

	it('confirmation footers on behalf of the (escaped) team name', () => {
		const html = generateConfirmationEmailHtml('Anne & Bob', 'https://x/c', 'Team <b>');
		expect(html).toContain('Sent by Owlat on behalf of Team &lt;b&gt;');
		expect(html).toContain('Hi Anne &amp; Bob,');
		expect(html).toContain('Confirm subscription');
	});

	// Regression-lock (audit "User-supplied display fields must be HTML-escaped",
	// the historically-flagged firstName -> DOI-email injection): firstName and
	// teamName are untrusted (firstName originates from a public form submit,
	// only .trim()'d) and MUST be HTML-escaped before they reach the DOI email
	// body/greeting/footer. OWASP XSS / HTML injection; RFC 5322 §2.2.
	it('DOI confirmation neutralizes a hostile firstName (no live <script>/onerror tag)', () => {
		const html = generateConfirmationEmailHtml(
			'<img src=x onerror=alert(1)>"><script>bad</script>',
			'https://app.test/confirm?token=abc',
			'Acme & <b>Co</b>'
		);

		// The injected markup is present only in escaped form.
		expect(html).toContain('&lt;img');
		expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');

		// No live <script> tag survives anywhere in the document chrome, and no
		// live <img ...> opener carries the onerror handler. (The literal substring
		// "onerror=" survives, but only INSIDE the escaped "&lt;img ... &gt;"
		// sequence — it is inert text, not an attribute on a live element.)
		expect(html).not.toContain('<script>bad');
		expect(html).not.toContain('<img');
		// Defensive: the only "onerror=" occurrence is the escaped one; assert the
		// greeting line carries the escaped form so the policy can't silently flip.
		expect(html).toContain(
			'Hi &lt;img src=x onerror=alert(1)&gt;&quot;&gt;&lt;script&gt;bad&lt;/script&gt;,'
		);

		// teamName is escaped everywhere it appears (subtitle + footer).
		expect(html).toContain('Acme &amp; &lt;b&gt;Co&lt;/b&gt;');
		expect(html).not.toContain('Acme & <b>Co</b>');
	});

	// Byte-length regression guard: these exact sizes were verified byte-identical
	// to the pre-refactor per-template generators for the same fixed inputs.
	it('output is byte-length-stable for fixed inputs (faithful extraction)', () => {
		expect(
			generateInvitationEmailHtml(
				'Acme & Co',
				"O'Brien",
				'o@acme.com',
				'https://x/accept?t=1',
				'admin'
			)
		).toHaveLength(3317);
		expect(generatePasswordResetEmailHtml('Jo <test>', 'https://x/reset?t=2')).toHaveLength(2987);
		expect(
			generateDeletionEmailHtml('u@x.com', 'Monday, June 1, 2026', 'https://x/cancel?t=3')
		).toHaveLength(4733);
		expect(
			generateConfirmationEmailHtml('Anne & Bob', 'https://x/confirm?t=4', 'Team <b>')
		).toHaveLength(3175);
	});
});
