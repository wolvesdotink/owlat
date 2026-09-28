/**
 * `buildMessagePreview` — the Team inbox row preview (`lastPreview`). An
 * html-only message previews its visible words through the shared HTML→text
 * pass, so CSS from a `<style>` block or an entity never shows in the row.
 */

import { describe, expect, it } from 'vitest';
import { buildMessagePreview } from '../textPreview';

describe('buildMessagePreview', () => {
	it('prefers the text body', () => {
		expect(buildMessagePreview({ text: '  Hello\n  there ', html: '<p>ignored</p>' })).toBe(
			'Hello there'
		);
	});

	it('falls back to the html when the text body is blank', () => {
		expect(buildMessagePreview({ text: '  ', html: '<p>Hi</p>' })).toBe('Hi');
	});

	it('drops <style> CSS, scripts and comments, and decodes entities', () => {
		const html =
			'<html><head><style>p { color: red }</style></head><body><!-- x -->' +
			'<p>Tom &amp; Jerry&#8217;s&nbsp;plan</p><script>t()</script></body></html>';
		expect(buildMessagePreview({ html })).toBe('Tom & Jerry’s plan');
	});

	it('returns undefined when nothing visible is left', () => {
		expect(buildMessagePreview({ html: '<style>p{}</style><p>&nbsp;</p>' })).toBeUndefined();
	});

	it('truncates with an ellipsis', () => {
		expect(buildMessagePreview({ text: 'abcdefghij', max: 5 })).toBe('abcd…');
	});
});
