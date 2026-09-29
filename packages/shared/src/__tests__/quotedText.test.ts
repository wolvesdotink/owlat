import { describe, it, expect } from 'vitest';
import { splitQuotedHtml } from '../quotedText';

describe('splitQuotedHtml — Outlook reply headers', () => {
	it('splits at desktop Outlook\'s top-bordered "From:" block', () => {
		const fresh =
			'<html><head><style>p.MsoNormal{margin:0}</style></head><body><div class=WordSection1>' +
			'<p class=MsoNormal>Thanks, that works.</p><p class=MsoNormal>&nbsp;</p>';
		const quoted =
			"<div style='border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm'>" +
			'<p class=MsoNormal><b>From:</b> Ada &lt;ada@example.com&gt;</p></div><p>Original</p></div></body></html>';
		const out = splitQuotedHtml(fresh + quoted);
		expect(out).toEqual({ fresh, quoted, hasQuote: true });
	});

	it('recognises the older #B5C4DF divider', () => {
		const html =
			'<p>Sure.</p><div style="border:none;border-top:solid #B5C4DF 1.0pt;padding:3pt 0 0 0"><p><b>Von:</b> x</p></div>';
		expect(splitQuotedHtml(html).fresh).toBe('<p>Sure.</p>');
	});

	it("splits at Outlook on the web's divRplyFwdMsg, taking its <hr> along", () => {
		const html =
			'<div>Sounds good.</div><hr style="display:inline-block;width:98%" tabindex="-1">' +
			'<div id="divRplyFwdMsg" dir="ltr"><b>From:</b> Ada</div><div>Original</div>';
		const out = splitQuotedHtml(html);
		expect(out.fresh).toBe('<div>Sounds good.</div>');
		expect(out.quoted.startsWith('<hr')).toBe(true);
	});

	it('does not fold away a bare forward with nothing written above the header', () => {
		const html =
			'<html><head><style>p{margin:0}</style></head><body><p>&nbsp;</p>' +
			'<div style="border:none;border-top:solid #E1E1E1 1.0pt"><p><b>From:</b> Ada</p></div><p>Forwarded body</p></body></html>';
		expect(splitQuotedHtml(html).hasQuote).toBe(false);
	});

	it('treats comments, numeric nbsp and a raw U+00A0 above the header as nothing written', () => {
		const html =
			'<head><title>Fwd</title></head><!--[if mso]>x<![endif]--><p>&#160;\u00a0&#xA0;</p>' +
			'<div style="border:none;border-top:solid #E1E1E1 1.0pt"><p><b>From:</b> Ada</p></div><p>Forwarded body</p>';
		expect(splitQuotedHtml(html).hasQuote).toBe(false);
	});

	it('still prefers the Gmail wrapper when both are present', () => {
		const html =
			'<div>Hi</div><div class="gmail_quote">On Mon, Ada wrote:<div style="border-top:solid #E1E1E1 1.0pt">x</div></div>';
		expect(splitQuotedHtml(html).fresh).toBe('<div>Hi</div>');
	});
});
