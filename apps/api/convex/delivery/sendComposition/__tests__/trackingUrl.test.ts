import { describe, it, expect } from 'vitest';
import { getTrackingPixelUrl, getTrackedLinkUrl } from '../trackingUrl';

// The trackingHttp.ts decode helper is byte-identical to this inline
// implementation. Verifying round-trip against it locks the encode/decode
// contract.
function base64UrlDecode(str: string): string {
	let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
	while (base64.length % 4) {
		base64 += '=';
	}
	return atob(base64);
}

function decodeUtf8(str: string): string {
	// Convert binary string (one char per byte) back to UTF-8 string.
	const bytes = new Uint8Array(str.length);
	for (let i = 0; i < str.length; i++) {
		bytes[i] = str.charCodeAt(i);
	}
	return new TextDecoder().decode(bytes);
}

describe('getTrackingPixelUrl', () => {
	it('builds the expected URL format', () => {
		expect(getTrackingPixelUrl('https://example.com', 'abc123')).toBe(
			'https://example.com/t/o/abc123',
		);
	});

	it('preserves trailing slash on convexSiteUrl (the caller owns sanitization)', () => {
		expect(getTrackingPixelUrl('https://example.com/', 'abc123')).toBe(
			'https://example.com//t/o/abc123',
		);
	});

	it('works with custom branded tracking domains', () => {
		expect(getTrackingPixelUrl('https://track.example.com', 'xyz789')).toBe(
			'https://track.example.com/t/o/xyz789',
		);
	});
});

describe('getTrackedLinkUrl', () => {
	it('builds the URL with base64url-encoded original URL', () => {
		const url = getTrackedLinkUrl('https://example.com', 'abc123', 'https://target.com/page');
		expect(url).toMatch(/^https:\/\/example\.com\/t\/c\/abc123\//);
		const encoded = url.split('/t/c/abc123/')[1]!;
		expect(decodeUtf8(base64UrlDecode(encoded))).toBe('https://target.com/page');
	});

	it('round-trips URLs with query parameters', () => {
		const original = 'https://target.com/page?param=value&other=123';
		const url = getTrackedLinkUrl('https://example.com', 'abc123', original);
		const encoded = url.split('/t/c/abc123/')[1]!;
		expect(decodeUtf8(base64UrlDecode(encoded))).toBe(original);
	});

	it('round-trips URLs with query and fragment', () => {
		const original = 'https://target.com/page?foo=bar#section';
		const url = getTrackedLinkUrl('https://example.com', 'abc123', original);
		const encoded = url.split('/t/c/abc123/')[1]!;
		expect(decodeUtf8(base64UrlDecode(encoded))).toBe(original);
	});

	it('round-trips long URLs', () => {
		const original =
			'https://target.com/very/long/path/with/many/segments?p1=v1&p2=v2&p3=v3&p4=v4';
		const url = getTrackedLinkUrl('https://example.com', 'abc123', original);
		const encoded = url.split('/t/c/abc123/')[1]!;
		expect(decodeUtf8(base64UrlDecode(encoded))).toBe(original);
	});

	it('round-trips UTF-8 multi-byte characters', () => {
		const original = 'https://target.com/page?name=José';
		const url = getTrackedLinkUrl('https://example.com', 'abc123', original);
		const encoded = url.split('/t/c/abc123/')[1]!;
		expect(decodeUtf8(base64UrlDecode(encoded))).toBe(original);
	});

	it('strips base64 padding from the encoded URL', () => {
		const url = getTrackedLinkUrl('https://example.com', 'abc123', 'https://t.co/');
		const encoded = url.split('/t/c/abc123/')[1]!;
		expect(encoded.endsWith('=')).toBe(false);
	});

	it('uses the URL-safe alphabet (no + or /)', () => {
		// "ÿ" → 0xC3 0xBF which encodes to "w78=" in standard base64 — exposes `+/`
		// when the input contains certain byte values. We pick a value designed to
		// surface them: a string of bytes that would yield "+/" in standard base64.
		// Bytes: 0xFB 0xEF 0xBE → "+++". Use them as URL content.
		const original = 'https://target.com/' + 'ûï¾';
		const url = getTrackedLinkUrl('https://example.com', 'abc123', original);
		const encoded = url.split('/t/c/abc123/')[1]!;
		expect(encoded).not.toMatch(/[+/]/);
	});
});
