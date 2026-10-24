import { describe, expect, it } from 'vitest';
import { buildBaseStyle, POSTBOX_COMFORT_STYLE_OPEN } from '../postboxBaseStyle';
import { MAIL_TYPOGRAPHY_DEFAULT, type MailTypography } from '../readingComfort';
import {
	POSTBOX_BODY_META_CSP,
	POSTBOX_BODY_META_CSP_NO_REMOTE,
	POSTBOX_SRCDOC_HEAD,
	postboxBodyPlaceholder,
} from '../postboxBodyPlaceholder';

const opts = (blockRemote: boolean, typography: MailTypography = MAIL_TYPOGRAPHY_DEFAULT) => ({
	blockRemote,
	typography,
});

function savedSrcdoc(style: string, body = '<p>hello</p><img src="https://img.example/a.png">') {
	return `${POSTBOX_SRCDOC_HEAD}${POSTBOX_BODY_META_CSP}${style}</head><body>${body}</body></html>`;
}

describe('postboxBodyPlaceholder', () => {
	it('returns null without a saved copy', () => {
		expect(postboxBodyPlaceholder(null, opts(true))).toBeNull();
		expect(postboxBodyPlaceholder('', opts(false))).toBeNull();
	});

	it('blocks every remote load when a live body is on its way', () => {
		const placeholder = postboxBodyPlaceholder(savedSrcdoc(buildBaseStyle('light')), opts(true));
		expect(placeholder).not.toBeNull();
		const srcdoc = placeholder?.srcdoc ?? '';
		const policy = srcdoc.slice(0, srcdoc.indexOf('<style>'));
		expect(policy).toContain("default-src 'none'; img-src data:;");
		expect(policy).not.toContain('https:');
		expect(srcdoc).not.toContain(POSTBOX_BODY_META_CSP);
		// The body itself is untouched; only the policy changes.
		expect(srcdoc).toContain('<p>hello</p><img src="https://img.example/a.png">');
	});

	it('serves a copy saved while images were blocked as it is', () => {
		const saved = `${POSTBOX_SRCDOC_HEAD}${POSTBOX_BODY_META_CSP_NO_REMOTE}${buildBaseStyle('light')}</head><body><p>hi</p></body></html>`;
		expect(postboxBodyPlaceholder(saved, opts(true))?.srcdoc).toBe(saved);
	});

	it('refuses a saved copy whose policy it cannot swap', () => {
		expect(
			postboxBodyPlaceholder('<!doctype html><html><body>legacy</body></html>', opts(true))
		).toBeNull();
	});

	it('serves the saved copy unchanged offline', () => {
		const saved = savedSrcdoc(buildBaseStyle('light'));
		expect(postboxBodyPlaceholder(saved, opts(false))?.srcdoc).toBe(saved);
	});

	it('reads the scheme and kind the saved copy was rendered with', () => {
		expect(
			postboxBodyPlaceholder(savedSrcdoc(buildBaseStyle('dark', 'simple')), opts(true))
		).toMatchObject({ scheme: 'dark', kind: 'simple' });
		expect(
			postboxBodyPlaceholder(savedSrcdoc(buildBaseStyle('light', 'designed')), opts(true))
		).toMatchObject({ scheme: 'light', kind: 'designed' });
		expect(
			postboxBodyPlaceholder(savedSrcdoc(buildBaseStyle('light', 'simple')), opts(false))
		).toMatchObject({ scheme: 'light', kind: 'simple' });
	});

	it('ignores look-alike markers in the message body', () => {
		const saved = savedSrcdoc(
			buildBaseStyle('light'),
			'<p>:root{color-scheme:dark;} html,body{background:transparent;}</p>'
		);
		expect(postboxBodyPlaceholder(saved, opts(true))).toMatchObject({
			scheme: 'light',
			kind: 'designed',
		});
	});

	it('re-applies the current text size and width to a copy saved under others', () => {
		const saved = savedSrcdoc(buildBaseStyle('light', 'simple'));
		const larger = postboxBodyPlaceholder(
			saved,
			opts(false, { textSize: 'larger', readingWidth: 'narrow' })
		)!.srcdoc;
		expect(larger).toContain('max-width:60ch;font-size:15px;zoom:1.267;');
		expect(larger).not.toContain('max-width:72ch');
		// One comfort block, still inside the head; the body is untouched.
		expect(larger.split(POSTBOX_COMFORT_STYLE_OPEN)).toHaveLength(2);
		expect(larger.indexOf(POSTBOX_COMFORT_STYLE_OPEN)).toBeLessThan(larger.indexOf('</head>'));
		expect(larger).toContain('<body><p>hello</p>');
	});

	it('adds the comfort block to a copy saved before it existed', () => {
		// The head a saved copy had before the reader's typography moved into its
		// own block: the measure and size sat inside the simple-mail rules.
		const legacyStyle =
			'<style>html,body{font-size:14px;}html,body{background:transparent;}body{max-width:72ch;font-size:15px;}</style>';
		const srcdoc = postboxBodyPlaceholder(
			savedSrcdoc(legacyStyle),
			opts(true, { textSize: 'large', readingWidth: 'full' })
		)!.srcdoc;
		// Last in the head, so it wins the cascade over the old values.
		expect(srcdoc).toContain(
			`body{max-width:72ch;font-size:15px;}</style>${POSTBOX_COMFORT_STYLE_OPEN}body{max-width:none;font-size:15px;zoom:1.133;}</style></head>`
		);
	});

	it('scales a saved designed body instead of re-measuring it', () => {
		const srcdoc = postboxBodyPlaceholder(
			savedSrcdoc(buildBaseStyle('light', 'designed')),
			opts(false, { textSize: 'larger', readingWidth: 'narrow' })
		)!.srcdoc;
		expect(srcdoc).toContain(`${POSTBOX_COMFORT_STYLE_OPEN}body{zoom:1.267;}</style>`);
		expect(srcdoc).not.toContain('60ch');
	});
});
