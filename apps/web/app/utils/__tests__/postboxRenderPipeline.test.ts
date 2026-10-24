// @vitest-environment node
/**
 * The string half of the body render runs in a worker, where there is no
 * `document`, `window` or `DOMParser`. This suite runs in plain Node (no DOM
 * globals at all) and asserts the pipeline's output and security invariants
 * there, so a stage that reaches for the DOM fails here before it fails in a
 * browser worker.
 */
import { describe, it, expect } from 'vitest';
import { renderPostboxBodyStage, type PostboxRenderStageInput } from '../postboxRenderPipeline';
import { adaptEmailHtml } from '../postboxDarkMode';

function input(overrides: Partial<PostboxRenderStageInput>): PostboxRenderStageInput {
	return {
		html: '',
		text: '',
		showQuoted: false,
		scheme: 'light',
		cidUrls: new Map(),
		...overrides,
	};
}

describe('renderPostboxBodyStage', () => {
	it('runs without any DOM global', () => {
		expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
		expect(typeof (globalThis as { DOMParser?: unknown }).DOMParser).toBe('undefined');
		expect(renderPostboxBodyStage(input({ html: '<p>Hi</p>' })).html).toBe('<p>Hi</p>');
	});

	it('sanitizes hostile markup before any other transform', () => {
		const { html } = renderPostboxBodyStage(
			input({
				html: [
					'<script>alert(1)</script>',
					'<style>body{background:url(https://x.example/a)}</style>',
					'<meta http-equiv="refresh" content="0;url=https://evil.example">',
					'<base href="https://evil.example/">',
					'<p onclick="steal()">Body</p>',
					'<a href="javascript:alert(1)">click</a>',
					'<iframe src="https://evil.example"></iframe>',
				].join(''),
			})
		);
		expect(html).not.toMatch(/<script|<style|<meta|<base|<iframe|onclick|javascript:/i);
		expect(html).toContain('<p>Body</p>');
	});

	it('opens every link in a new context without referrer or opener', () => {
		const { html } = renderPostboxBodyStage(
			input({ html: '<a href="https://shop.example/x" target="_self" rel="opener">Shop</a>' })
		);
		expect(html).toContain('target="_blank" rel="noreferrer noopener"');
		expect(html).not.toContain('_self');
		expect(html).not.toContain('rel="opener"');
	});

	it('marks a link whose text names a different host than its destination', () => {
		const { html } = renderPostboxBodyStage(
			input({ html: '<a href="https://evil.example/login">https://bank.example</a>' })
		);
		expect(html).toContain('title="evil.example"');
		expect(html).toContain('evil.example</span>');
	});

	it('strips tracking parameters from link destinations', () => {
		const { html } = renderPostboxBodyStage(
			input({ html: '<a href="https://shop.example/p?id=4&utm_source=mail">Item</a>' })
		);
		expect(html).toContain('href="https://shop.example/p?id=4"');
		expect(html).not.toContain('utm_source');
	});

	it('adapts simple mail to the dark scheme exactly as the dark-mode pass does', () => {
		const body = '<p style="color:#000000">Dark text</p>';
		const out = renderPostboxBodyStage(input({ html: body, scheme: 'dark' }));
		const direct = adaptEmailHtml(body, 'dark');
		expect(out.scheme).toBe('dark');
		expect(out.kind).toBe(direct.kind);
		expect(out.html).toBe(direct.html);
	});

	it('keeps designed mail light on a dark app', () => {
		const out = renderPostboxBodyStage(
			input({
				html: '<table style="background-color:#0a2540"><tr><td style="color:#ffffff">Promo</td></tr></table>',
				scheme: 'dark',
			})
		);
		expect(out.kind).toBe('designed');
		expect(out.scheme).toBe('light');
	});

	it('folds the quoted chain away unless asked, and reports that it has one', () => {
		const html = '<p>Fresh reply</p><br><br><blockquote><p>Earlier message</p></blockquote>';
		const folded = renderPostboxBodyStage(input({ html }));
		expect(folded.hasQuote).toBe(true);
		expect(folded.html).toContain('Fresh reply');
		expect(folded.html).not.toContain('Earlier message');
		expect(folded.html).not.toMatch(/<br \/?>\s*$/);

		const shown = renderPostboxBodyStage(input({ html, showQuoted: true }));
		expect(shown.hasQuote).toBe(true);
		expect(shown.html).toContain('Earlier message');
		expect(shown.html).toContain('<hr');
	});

	it('escapes a text body and keeps its line breaks', () => {
		const out = renderPostboxBodyStage(
			input({ text: 'a < b & c > d\nnext line\n\n> quoted line' })
		);
		expect(out.html).toContain('a &lt; b &amp; c &gt; d<br />next line');
		expect(out.html).not.toContain('quoted line');
		expect(out.hasQuote).toBe(true);
	});

	it('swaps resolved cid: references for their data: URLs after sanitizing', () => {
		const out = renderPostboxBodyStage(
			input({
				html: '<img src="cid:logo@x.example" alt="Logo"><img src="cid:missing@x.example">',
				cidUrls: new Map([['logo@x.example', 'data:image/png;base64,AAAA']]),
			})
		);
		expect(out.html).toContain('src="data:image/png;base64,AAAA"');
		expect(out.html).toContain('src="cid:missing@x.example"');
	});
});
