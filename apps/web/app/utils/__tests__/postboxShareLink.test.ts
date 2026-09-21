import { describe, expect, it } from 'vitest';
import {
	appendShareLinkBlock,
	postboxShareLinkScopeKey,
	postboxShareLinkStatusKey,
	postboxShareLinkSummary,
	shareLinkBlockHtml,
	shouldOfferShareLink,
} from '../postboxShareLink';

const block = (over: Partial<Parameters<typeof shareLinkBlockHtml>[0]> = {}) =>
	shareLinkBlockHtml({
		url: 'https://x.convex.site/attachment-share/tok',
		filename: 'quarterly.pdf',
		heading: 'Shared file',
		meta: '4.2 MB · link expires 12 March',
		...over,
	});

describe('shareLinkBlockHtml', () => {
	it('links the filename to the share URL', () => {
		const html = block();
		expect(html).toContain('href="https://x.convex.site/attachment-share/tok"');
		expect(html).toContain('>quarterly.pdf</a>');
		expect(html).toContain('Shared file');
		expect(html).toContain('4.2 MB · link expires 12 March');
	});

	it('escapes a filename so it cannot inject markup into the body', () => {
		const html = block({ filename: '<img src=x onerror=alert(1)>.pdf' });
		expect(html).not.toContain('<img');
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.pdf');
	});

	it('escapes the URL for attribute context so it cannot break out of href', () => {
		const html = block({ url: 'https://x/"><script>alert(1)</script>' });
		expect(html).not.toContain('<script>');
		expect(html).toContain('&quot;&gt;&lt;script&gt;');
	});

	it('escapes the resolved copy too, since a locale string is still content', () => {
		expect(block({ heading: 'a < b' })).toContain('a &lt; b');
	});

	it('emits only markup a mail client will keep', () => {
		const html = block();
		// No flex, no custom properties, no classes carrying meaning — the block
		// has to survive Outlook and a plain-text degrade.
		expect(html).not.toMatch(/display:\s*flex/);
		expect(html).not.toContain('var(--');
		expect(html.startsWith('<div')).toBe(true);
		expect(html.endsWith('</div>')).toBe(true);
	});
});

describe('appendShareLinkBlock', () => {
	it('appends below the message rather than above it', () => {
		const out = appendShareLinkBlock('<p>Here you go.</p>', '<div>BLOCK</div>');
		expect(out.indexOf('Here you go')).toBeLessThan(out.indexOf('BLOCK'));
	});

	it('still produces a body when the message is empty or whitespace', () => {
		expect(appendShareLinkBlock('', '<div>BLOCK</div>')).toBe('<div>BLOCK</div>');
		expect(appendShareLinkBlock('   \n ', '<div>BLOCK</div>')).toBe('<div>BLOCK</div>');
	});

	it('leaves the existing body untouched', () => {
		expect(appendShareLinkBlock('<p>a</p>', 'B')).toBe('<p>a</p>B');
	});
});

describe('the list copy', () => {
	it('names a state key per lifecycle state', () => {
		expect(postboxShareLinkStatusKey('live')).toBe('shared.postboxShareLink.state.live');
		expect(postboxShareLinkStatusKey('revoked')).toBe('shared.postboxShareLink.state.revoked');
		expect(postboxShareLinkStatusKey('expired')).toBe('shared.postboxShareLink.state.expired');
	});

	it('names a scope key per scope', () => {
		expect(postboxShareLinkScopeKey('anyone')).toBe('shared.postboxShareLink.scope.anyone');
		expect(postboxShareLinkScopeKey('mailbox')).toBe('shared.postboxShareLink.scope.mailbox');
	});

	it('summarises with the download count, which is what decides a revoke', () => {
		expect(postboxShareLinkSummary('live', 40)).toEqual({
			key: 'shared.postboxShareLink.summary.live',
			params: { downloads: 40 },
		});
	});

	it('keys the summary off the state the server resolved, not a local guess', () => {
		expect(postboxShareLinkSummary('revoked', 0).key).toBe(
			'shared.postboxShareLink.summary.revoked'
		);
		expect(postboxShareLinkSummary('expired', 3).key).toBe(
			'shared.postboxShareLink.summary.expired'
		);
	});
});

describe('shouldOfferShareLink', () => {
	it('offers the swap exactly when the meter starts warning', () => {
		expect(shouldOfferShareLink({ amber: false, over: false })).toBe(false);
		expect(shouldOfferShareLink({ amber: true, over: false })).toBe(true);
		expect(shouldOfferShareLink({ amber: false, over: true })).toBe(true);
	});
});
