import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { hmacSignature } from '../../../webhooks/security';
import {
	decodeTrackedTarget,
	encodeTrackedTarget,
	getTrackingPixelUrl,
	trackedLinkPath,
	trackedLinkSigningInput,
} from '../trackingUrl';

describe('getTrackingPixelUrl', () => {
	it('builds the expected URL format', () => {
		expect(getTrackingPixelUrl('https://example.com', 'abc123')).toBe(
			'https://example.com/t/o/abc123'
		);
	});

	it('preserves trailing slash on convexSiteUrl (the caller owns sanitization)', () => {
		expect(getTrackingPixelUrl('https://example.com/', 'abc123')).toBe(
			'https://example.com//t/o/abc123'
		);
	});

	it('works with custom branded tracking domains', () => {
		expect(getTrackingPixelUrl('https://track.example.com', 'xyz789')).toBe(
			'https://track.example.com/t/o/xyz789'
		);
	});
});

describe('encodeTrackedTarget / decodeTrackedTarget', () => {
	const IDN_TARGET = 'https://bücher.de/ä?q=ü';

	it.each([
		['plain ASCII', 'https://target.com/page'],
		['query parameters', 'https://target.com/page?param=value&other=123'],
		['query and fragment', 'https://target.com/page?foo=bar#section'],
		['a long path', 'https://target.com/very/long/path/with/many/segments?p1=v1&p2=v2&p3=v3'],
		['a Latin-1 character', 'https://target.com/page?name=José'],
		['an IDN host and umlauts', IDN_TARGET],
		['an emoji', 'https://example.com/🎉?party=🥳'],
	])('round-trips a target with %s', (_label, original) => {
		expect(decodeTrackedTarget(encodeTrackedTarget(original))).toBe(original);
	});

	it('decodes an IDN target as UTF-8, so the redirect keeps its host', () => {
		const decoded = decodeTrackedTarget(encodeTrackedTarget(IDN_TARGET));
		const url = new URL(decoded);
		expect(url.host).toBe('xn--bcher-kva.de');
		expect(url.pathname).toBe('/%C3%A4');
		expect(url.searchParams.get('q')).toBe('ü');
	});

	// Links already in recipients' mailboxes were encoded by Node's Buffer
	// before the shared codec existed. They must keep decoding to the same href.
	it.each([
		'https://target.com/page?x=1',
		IDN_TARGET,
		'https://example.com/🎉',
		'https://target.com/ûï¾',
	])('decodes a segment encoded by Buffer base64url identically: %s', (href) => {
		const legacySegment = Buffer.from(href, 'utf-8').toString('base64url');
		expect(encodeTrackedTarget(href)).toBe(legacySegment);
		expect(decodeTrackedTarget(legacySegment)).toBe(href);
	});

	it('strips base64 padding from the encoded URL', () => {
		expect(encodeTrackedTarget('https://t.co/').endsWith('=')).toBe(false);
	});

	it('uses the URL-safe alphabet (no + or /)', () => {
		// 0xFB 0xEF 0xBE encodes to "++++" in standard base64; as UTF-8 text
		// these code points yield the same kind of bytes.
		expect(encodeTrackedTarget('https://target.com/ûï¾')).not.toMatch(/[+/]/);
	});
});

describe('tracked-link signature', () => {
	const secret = 'test-unsubscribe-secret';
	const emailSendId = 'jd7abc123';

	it('signs `{emailSendId}.{encodedUrl}`', () => {
		expect(trackedLinkSigningInput(emailSendId, 'aHR0cHM')).toBe('jd7abc123.aHR0cHM');
	});

	// The encoder (`transform.ts`, Node) and the verifier (`trackingHttp.ts`,
	// Web Crypto) compute the same digest over the same signing input.
	it.each(['https://target.com/page', 'https://bücher.de/ä?q=ü'])(
		'the Node createHmac digest equals the hmacSignature base64url output for %s',
		async (href) => {
			const input = trackedLinkSigningInput(emailSendId, encodeTrackedTarget(href));
			const nodeDigest = createHmac('sha256', secret).update(input).digest('base64url');
			await expect(hmacSignature(secret, input, 'sha256', 'base64url')).resolves.toBe(nodeDigest);
		}
	);

	it('builds the signed click path the handler parses', () => {
		expect(trackedLinkPath('https://track.example.com', emailSendId, 'ZW5j', 'c2ln')).toBe(
			'https://track.example.com/t/c/jd7abc123/ZW5j/c2ln'
		);
	});
});
