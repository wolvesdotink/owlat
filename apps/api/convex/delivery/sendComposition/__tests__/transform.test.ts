import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { transformHtml, type TransformConfig } from '../transform';

// transformHtml now HMAC-signs tracked links with UNSUBSCRIBE_SECRET (binding
// the redirect target to its emailSendId to defeat open redirects). Provide a
// deterministic secret so the link-tracking assertions exercise the signed path
// rather than the "no secret → leave untracked" fallback.
const ORIGINAL_UNSUB_SECRET = process.env['UNSUBSCRIBE_SECRET'];
beforeAll(() => {
	process.env['UNSUBSCRIBE_SECRET'] = 'test-unsubscribe-secret';
});
afterAll(() => {
	if (ORIGINAL_UNSUB_SECRET === undefined) delete process.env['UNSUBSCRIBE_SECRET'];
	else process.env['UNSUBSCRIBE_SECRET'] = ORIGINAL_UNSUB_SECRET;
});

describe('transformHtml — footer injection', () => {
	it('adds unsubscribe/preference footer when both URLs provided', () => {
		const html = '<body><p>Hello</p></body>';
		const config: TransformConfig = {
			unsubscribeUrl: 'https://example.com/unsubscribe',
			preferenceUrl: 'https://example.com/preferences',
		};

		const result = transformHtml(html, config);

		expect(result).toContain('Manage Preferences');
		expect(result).toContain('Unsubscribe');
		expect(result).toContain('href="https://example.com/preferences"');
		expect(result).toContain('href="https://example.com/unsubscribe"');
		expect(result).toContain('border-top: 1px solid #e5e7eb');
	});

	it('injects footer into body tag when present', () => {
		const html = '<html><body><p>Content</p></body></html>';
		const config: TransformConfig = {
			unsubscribeUrl: 'https://example.com/unsubscribe',
			preferenceUrl: 'https://example.com/preferences',
		};

		const result = transformHtml(html, config);

		expect(result).toContain('<body>');
		expect(result).toContain('</body>');
		expect(result).toContain('Manage Preferences');
		// Footer should be inside body, before closing tag
		const bodyEndIndex = result.indexOf('</body>');
		const footerIndex = result.indexOf('Manage Preferences');
		expect(footerIndex).toBeLessThan(bodyEndIndex);
	});

	it('injects footer to root when no body tag', () => {
		const html = '<p>Hello</p>';
		const config: TransformConfig = {
			unsubscribeUrl: 'https://example.com/unsubscribe',
			preferenceUrl: 'https://example.com/preferences',
		};

		const result = transformHtml(html, config);

		expect(result).toContain('Manage Preferences');
		expect(result).toContain('Unsubscribe');
	});

	it('does not add footer when only unsubscribe URL provided', () => {
		const html = '<body><p>Hello</p></body>';
		const config: TransformConfig = {
			unsubscribeUrl: 'https://example.com/unsubscribe',
		};

		const result = transformHtml(html, config);

		expect(result).not.toContain('Manage Preferences');
		expect(result).not.toContain('Unsubscribe');
	});

	it('does not add footer when only preference URL provided', () => {
		const html = '<body><p>Hello</p></body>';
		const config: TransformConfig = {
			preferenceUrl: 'https://example.com/preferences',
		};

		const result = transformHtml(html, config);

		expect(result).not.toContain('Manage Preferences');
		expect(result).not.toContain('Unsubscribe');
	});

	it('does not add footer when neither URL provided', () => {
		const html = '<body><p>Hello</p></body>';
		const config: TransformConfig = {};

		const result = transformHtml(html, config);

		expect(result).not.toContain('Manage Preferences');
		expect(result).not.toContain('Unsubscribe');
	});
});

describe('transformHtml — link tracking', () => {
	it('wraps regular http links', () => {
		const html = '<body><a href="https://example.com">Click</a></body>';
		const config: TransformConfig = {
			trackedLinkBase: { siteUrl: 'https://convex.site', emailSendId: 'send123' },
		};

		const result = transformHtml(html, config);

		expect(result).toContain('href="https://convex.site/t/c/send123/');
		expect(result).not.toContain('href="https://example.com"');
		// Signed format: /t/c/{id}/{encodedUrl}/{signature} — two segments after the id.
		expect(result).toMatch(/href="https:\/\/convex\.site\/t\/c\/send123\/[^/"]+\/[^/"]+"/);
	});

	it('leaves links untracked when no signing secret is configured', () => {
		const prev = process.env['UNSUBSCRIBE_SECRET'];
		delete process.env['UNSUBSCRIBE_SECRET'];
		try {
			const html = '<body><a href="https://example.com">Click</a></body>';
			const config: TransformConfig = {
				trackedLinkBase: { siteUrl: 'https://convex.site', emailSendId: 'send123' },
			};
			const result = transformHtml(html, config);
			// No forgeable unsigned tracking link is emitted — the original href stays.
			expect(result).toContain('href="https://example.com"');
			expect(result).not.toContain('/t/c/');
		} finally {
			process.env['UNSUBSCRIBE_SECRET'] = prev;
		}
	});

	it('skips mailto: links', () => {
		const html = '<body><a href="mailto:test@example.com">Email</a></body>';
		const config: TransformConfig = {
			trackedLinkBase: { siteUrl: 'https://convex.site', emailSendId: 'send123' },
		};

		const result = transformHtml(html, config);

		expect(result).toContain('href="mailto:test@example.com"');
		expect(result).not.toContain('/t/c/');
	});

	it('skips tel: links', () => {
		const html = '<body><a href="tel:+1234567890">Call</a></body>';
		const config: TransformConfig = {
			trackedLinkBase: { siteUrl: 'https://convex.site', emailSendId: 'send123' },
		};

		const result = transformHtml(html, config);

		expect(result).toContain('href="tel:+1234567890"');
		expect(result).not.toContain('/t/c/');
	});

	it('skips # anchor links', () => {
		const html = '<body><a href="#section">Jump</a></body>';
		const config: TransformConfig = {
			trackedLinkBase: { siteUrl: 'https://convex.site', emailSendId: 'send123' },
		};

		const result = transformHtml(html, config);

		expect(result).toContain('href="#section"');
		expect(result).not.toContain('/t/c/');
	});

	it('skips javascript: links', () => {
		const html = '<body><a href="javascript:alert(1)">Alert</a></body>';
		const config: TransformConfig = {
			trackedLinkBase: { siteUrl: 'https://convex.site', emailSendId: 'send123' },
		};

		const result = transformHtml(html, config);

		expect(result).toContain('href="javascript:alert(1)"');
		expect(result).not.toContain('/t/c/');
	});

	it('skips javascript: links case insensitive', () => {
		const html = '<body><a href="JavaScript:alert(1)">Alert</a></body>';
		const config: TransformConfig = {
			trackedLinkBase: { siteUrl: 'https://convex.site', emailSendId: 'send123' },
		};

		const result = transformHtml(html, config);

		expect(result).toContain('href="JavaScript:alert(1)"');
		expect(result).not.toContain('/t/c/');
	});

	it('skips already-tracked /t/c/ links', () => {
		const html = '<body><a href="https://convex.site/t/c/other123/abc">Link</a></body>';
		const config: TransformConfig = {
			trackedLinkBase: { siteUrl: 'https://convex.site', emailSendId: 'send123' },
		};

		const result = transformHtml(html, config);

		// Should keep original tracked link, not double-wrap
		expect(result).toContain('href="https://convex.site/t/c/other123/abc"');
		// Should not contain new tracking with send123
		const matches = result.match(/\/t\/c\//g);
		expect(matches?.length).toBe(1);
	});

	it('tracks multiple links independently', () => {
		const html =
			'<body><a href="https://example1.com">Link1</a><a href="https://example2.com">Link2</a></body>';
		const config: TransformConfig = {
			trackedLinkBase: { siteUrl: 'https://convex.site', emailSendId: 'send123' },
		};

		const result = transformHtml(html, config);

		// Both links should be tracked
		const matches = result.match(/href="https:\/\/convex\.site\/t\/c\/send123\//g);
		expect(matches?.length).toBe(2);
	});

	it('does not track links when trackedLinkBase not provided', () => {
		const html = '<body><a href="https://example.com">Click</a></body>';
		const config: TransformConfig = {};

		const result = transformHtml(html, config);

		expect(result).toContain('href="https://example.com"');
		expect(result).not.toContain('/t/c/');
	});

	it('tracks footer links when both footer and tracking enabled', () => {
		const html = '<body><p>Content</p></body>';
		const config: TransformConfig = {
			unsubscribeUrl: 'https://example.com/unsubscribe',
			preferenceUrl: 'https://example.com/preferences',
			trackedLinkBase: { siteUrl: 'https://convex.site', emailSendId: 'send123' },
		};

		const result = transformHtml(html, config);

		// Footer should be present
		expect(result).toContain('Manage Preferences');
		expect(result).toContain('Unsubscribe');

		// Footer links should be tracked (footer injected first, then tracked)
		expect(result).toContain('https://convex.site/t/c/send123/');

		// Original URLs should not be in href attributes (they should be encoded)
		expect(result).not.toContain('href="https://example.com/unsubscribe"');
		expect(result).not.toContain('href="https://example.com/preferences"');
	});

	it('skips view-in-browser link from tracking', () => {
		const html = '<body><p>Hi</p></body>';
		const config: TransformConfig = {
			viewInBrowserUrl: 'https://archive.example.com/abc',
			trackedLinkBase: { siteUrl: 'https://convex.site', emailSendId: 'send123' },
		};

		const result = transformHtml(html, config);

		// view-in-browser link should remain as-is, not tracked
		expect(result).toContain('href="https://archive.example.com/abc"');
		// data-no-track should be removed after the link is preserved
		expect(result).not.toContain('data-no-track');
	});
});

describe('transformHtml — tracking pixel', () => {
	it('injects 1x1 pixel at end of body', () => {
		const html = '<body><p>Hello</p></body>';
		const config: TransformConfig = {
			trackingPixelUrl: 'https://example.com/pixel.png',
		};

		const result = transformHtml(html, config);

		expect(result).toContain('<img src="https://example.com/pixel.png"');
		expect(result).toContain('width="1"');
		expect(result).toContain('height="1"');
		expect(result).toContain('display:none');

		// Pixel should be before closing body tag
		const bodyEndIndex = result.indexOf('</body>');
		const pixelIndex = result.indexOf('<img src="https://example.com/pixel.png"');
		expect(pixelIndex).toBeLessThan(bodyEndIndex);
	});

	it('injects pixel to root when no body tag', () => {
		const html = '<p>Hello</p>';
		const config: TransformConfig = {
			trackingPixelUrl: 'https://example.com/pixel.png',
		};

		const result = transformHtml(html, config);

		expect(result).toContain('<img src="https://example.com/pixel.png"');
		expect(result).toContain('width="1"');
		expect(result).toContain('height="1"');
	});

	it('does not inject pixel when trackingPixelUrl not provided', () => {
		const html = '<body><p>Hello</p></body>';
		const config: TransformConfig = {};

		const result = transformHtml(html, config);

		expect(result).not.toContain('<img');
	});

	it('injects pixel with correct attributes', () => {
		const html = '<body><p>Hello</p></body>';
		const config: TransformConfig = {
			trackingPixelUrl: 'https://example.com/t/o/send123',
		};

		const result = transformHtml(html, config);

		expect(result).toMatch(
			/<img src="https:\/\/example\.com\/t\/o\/send123" width="1" height="1" alt="" style="[^"]*display:none[^"]*"/,
		);
	});
});

describe('transformHtml — combined transformations', () => {
	it('applies all three transformations together', () => {
		const html = '<body><a href="https://example.com">Link</a></body>';
		const config: TransformConfig = {
			unsubscribeUrl: 'https://example.com/unsubscribe',
			preferenceUrl: 'https://example.com/preferences',
			trackedLinkBase: { siteUrl: 'https://convex.site', emailSendId: 'send123' },
			trackingPixelUrl: 'https://convex.site/t/o/send123',
		};

		const result = transformHtml(html, config);

		// Footer present
		expect(result).toContain('Manage Preferences');
		expect(result).toContain('Unsubscribe');

		// Links tracked (including footer links)
		expect(result).toContain('https://convex.site/t/c/send123/');

		// Pixel present
		expect(result).toContain('<img src="https://convex.site/t/o/send123"');
	});

	it('handles complex HTML with all transformations', () => {
		const html = `
		<html>
		  <body>
			<h1>Newsletter</h1>
			<p>Check out <a href="https://blog.example.com">our blog</a>!</p>
			<p>Contact us at <a href="mailto:hello@example.com">hello@example.com</a></p>
		  </body>
		</html>
	  `;
		const config: TransformConfig = {
			unsubscribeUrl: 'https://example.com/unsubscribe',
			preferenceUrl: 'https://example.com/preferences',
			trackedLinkBase: { siteUrl: 'https://convex.site', emailSendId: 'send123' },
			trackingPixelUrl: 'https://convex.site/t/o/send123',
		};

		const result = transformHtml(html, config);

		// Blog link tracked
		expect(result).toMatch(/href="https:\/\/convex\.site\/t\/c\/send123\/[^"]+"/);
		expect(result).not.toContain('href="https://blog.example.com"');

		// Mailto not tracked
		expect(result).toContain('href="mailto:hello@example.com"');

		// Footer present
		expect(result).toContain('Manage Preferences');

		// Pixel present
		expect(result).toContain('<img src="https://convex.site/t/o/send123"');
	});

	it('applies no transformations when config is empty', () => {
		const html = '<body><a href="https://example.com">Link</a></body>';
		const config: TransformConfig = {};

		const result = transformHtml(html, config);

		// Link unchanged
		expect(result).toContain('href="https://example.com"');
		expect(result).not.toContain('/t/c/');

		// No footer
		expect(result).not.toContain('Manage Preferences');

		// No pixel
		expect(result).not.toContain('<img');
	});

	it('preserves HTML structure', () => {
		const html = `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
  <div class="container">
	<p>Content</p>
  </div>
</body>
</html>`;
		const config: TransformConfig = {};

		const result = transformHtml(html, config);

		expect(result).toContain('<html>');
		expect(result).toContain('<head>');
		expect(result).toContain('<title>Test</title>');
		expect(result).toContain('<body>');
		expect(result).toContain('<div class="container">');
	});

	it('handles order of operations correctly', () => {
		const html = '<body><p>Original content</p></body>';
		const config: TransformConfig = {
			unsubscribeUrl: 'https://example.com/unsub',
			preferenceUrl: 'https://example.com/prefs',
			trackedLinkBase: { siteUrl: 'https://convex.site', emailSendId: 'send123' },
			trackingPixelUrl: 'https://convex.site/t/o/send123',
		};

		const result = transformHtml(html, config);

		// Footer should appear before pixel (footer added first, pixel added last)
		const footerIndex = result.indexOf('Manage Preferences');
		const pixelIndex = result.indexOf('<img src="https://convex.site/t/o/send123"');
		expect(footerIndex).toBeLessThan(pixelIndex);

		// Both should be inside body tag
		const bodyEndIndex = result.indexOf('</body>');
		expect(footerIndex).toBeLessThan(bodyEndIndex);
		expect(pixelIndex).toBeLessThan(bodyEndIndex);
	});
});

describe('transformHtml — view-in-browser injection', () => {
	it('prepends view-in-browser link at top of body', () => {
		const html = '<body><p>Hello</p></body>';
		const config: TransformConfig = {
			viewInBrowserUrl: 'https://archive.example.com/abc',
		};

		const result = transformHtml(html, config);

		expect(result).toContain('href="https://archive.example.com/abc"');
		expect(result).toContain('View in browser');

		// View in browser should be before the original content
		const viewIndex = result.indexOf('View in browser');
		const helloIndex = result.indexOf('Hello');
		expect(viewIndex).toBeLessThan(helloIndex);
	});

	it('prepends view-in-browser to root when no body tag', () => {
		const html = '<p>Hello</p>';
		const config: TransformConfig = {
			viewInBrowserUrl: 'https://archive.example.com/abc',
		};

		const result = transformHtml(html, config);

		expect(result).toContain('View in browser');
	});

	it('does not inject view-in-browser when not configured', () => {
		const html = '<body><p>Hello</p></body>';
		const config: TransformConfig = {};

		const result = transformHtml(html, config);

		expect(result).not.toContain('View in browser');
	});
});

describe('transformHtml — edge cases', () => {
	it('handles empty HTML', () => {
		const html = '';
		const config: TransformConfig = {
			trackingPixelUrl: 'https://example.com/pixel.png',
		};

		const result = transformHtml(html, config);

		expect(result).toContain('<img');
	});

	it('handles malformed HTML', () => {
		const html = '<body><p>Unclosed paragraph<div>Content</body>';
		const config: TransformConfig = {
			trackedLinkBase: { siteUrl: 'https://convex.site', emailSendId: 'send123' },
		};

		// Should not throw error
		expect(() => transformHtml(html, config)).not.toThrow();
	});

	it('handles HTML with multiple body tags', () => {
		const html = '<body><p>First</p></body><body><p>Second</p></body>';
		const config: TransformConfig = {
			trackingPixelUrl: 'https://example.com/pixel.png',
		};

		const result = transformHtml(html, config);

		// Should inject into first body tag
		expect(result).toContain('<img');
	});

	it('handles links without href attribute', () => {
		const html = '<body><a>No href</a></body>';
		const config: TransformConfig = {
			trackedLinkBase: { siteUrl: 'https://convex.site', emailSendId: 'send123' },
		};

		// Should not throw error
		expect(() => transformHtml(html, config)).not.toThrow();
	});

	it('handles HTML comments with </body> in them', () => {
		const html = '<body><p>Content</p><!-- This comment has </body> in it --></body>';
		const config: TransformConfig = {
			trackingPixelUrl: 'https://example.com/pixel.png',
		};

		const result = transformHtml(html, config);

		// Pixel should be injected at the real end of body, not in comment
		expect(result).toContain('<img');
	});
});
