import { describe, expect, it } from 'vitest';
import { buildBaseStyle } from '../postboxDarkMode';
import {
	POSTBOX_BODY_META_CSP,
	POSTBOX_SRCDOC_HEAD,
	postboxBodyPlaceholder,
} from '../postboxBodyPlaceholder';

function savedSrcdoc(style: string, body = '<p>hello</p><img src="https://img.example/a.png">') {
	return `${POSTBOX_SRCDOC_HEAD}${POSTBOX_BODY_META_CSP}${style}</head><body>${body}</body></html>`;
}

describe('postboxBodyPlaceholder', () => {
	it('returns null without a saved copy', () => {
		expect(postboxBodyPlaceholder(null, { blockRemote: true })).toBeNull();
		expect(postboxBodyPlaceholder('', { blockRemote: false })).toBeNull();
	});

	it('blocks every remote load when a live body is on its way', () => {
		const placeholder = postboxBodyPlaceholder(savedSrcdoc(buildBaseStyle('light')), {
			blockRemote: true,
		});
		expect(placeholder).not.toBeNull();
		const srcdoc = placeholder?.srcdoc ?? '';
		const policy = srcdoc.slice(0, srcdoc.indexOf('<style>'));
		expect(policy).toContain("default-src 'none'; img-src data:;");
		expect(policy).not.toContain('https:');
		expect(srcdoc).not.toContain(POSTBOX_BODY_META_CSP);
		// The body itself is untouched; only the policy changes.
		expect(srcdoc).toContain('<p>hello</p><img src="https://img.example/a.png">');
	});

	it('refuses a saved copy whose policy it cannot swap', () => {
		expect(
			postboxBodyPlaceholder('<!doctype html><html><body>legacy</body></html>', {
				blockRemote: true,
			})
		).toBeNull();
	});

	it('serves the saved copy unchanged offline', () => {
		const saved = savedSrcdoc(buildBaseStyle('light'));
		expect(postboxBodyPlaceholder(saved, { blockRemote: false })?.srcdoc).toBe(saved);
	});

	it('reads the scheme and kind the saved copy was rendered with', () => {
		expect(
			postboxBodyPlaceholder(savedSrcdoc(buildBaseStyle('dark', 'simple')), {
				blockRemote: true,
			})
		).toMatchObject({ scheme: 'dark', kind: 'simple' });
		expect(
			postboxBodyPlaceholder(savedSrcdoc(buildBaseStyle('light', 'designed')), {
				blockRemote: true,
			})
		).toMatchObject({ scheme: 'light', kind: 'designed' });
		expect(
			postboxBodyPlaceholder(savedSrcdoc(buildBaseStyle('light', 'simple')), {
				blockRemote: false,
			})
		).toMatchObject({ scheme: 'light', kind: 'simple' });
	});

	it('ignores look-alike markers in the message body', () => {
		const saved = savedSrcdoc(
			buildBaseStyle('light'),
			'<p>:root{color-scheme:dark;} html,body{background:transparent;}</p>'
		);
		expect(postboxBodyPlaceholder(saved, { blockRemote: true })).toMatchObject({
			scheme: 'light',
			kind: 'designed',
		});
	});
});
