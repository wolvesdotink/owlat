import { describe, it, expect } from 'vitest';
import {
	CSRF_REJECTION_STATUS_MESSAGE,
	isCsrfRejection,
	readCsrfToken,
	shouldAttachCsrfToken,
	withCsrfHeader,
	writeCsrfToken,
} from '~/lib/csrf';

const HREF = 'https://mail.acme.test/dashboard/admin/instance/features';

describe('shouldAttachCsrfToken — methods', () => {
	it('covers every method nuxt-csurf guards', () => {
		for (const method of ['POST', 'PUT', 'PATCH', 'post', 'patch']) {
			expect(shouldAttachCsrfToken({ request: '/api/system/update', method, href: HREF })).toBe(
				true
			);
		}
	});

	it('leaves the methods the middleware ignores alone', () => {
		for (const method of ['GET', 'HEAD', 'DELETE', undefined]) {
			expect(
				shouldAttachCsrfToken({ request: '/api/system/profile-drift', method, href: HREF })
			).toBe(false);
		}
	});
});

describe('shouldAttachCsrfToken — origin', () => {
	it('attaches to relative paths, with or without a leading slash', () => {
		expect(shouldAttachCsrfToken({ request: '/api/setup/apply', method: 'POST', href: HREF })).toBe(
			true
		);
		expect(shouldAttachCsrfToken({ request: 'api/setup/apply', method: 'POST', href: HREF })).toBe(
			true
		);
	});

	it('attaches to an absolute URL that names this origin', () => {
		expect(
			shouldAttachCsrfToken({
				request: 'https://mail.acme.test/api/system/apply-profiles',
				method: 'POST',
				href: HREF,
			})
		).toBe(true);
	});

	it('never leaks the token to another origin', () => {
		for (const request of [
			'https://other.example/collect',
			// Protocol-relative: resolves to another origin, not to a local path.
			'//other.example/collect',
			'https://mail.acme.test.other.example/collect',
			// A different port is a different origin.
			'https://mail.acme.test:8443/api/system/update',
		]) {
			expect(shouldAttachCsrfToken({ request, method: 'POST', href: HREF })).toBe(false);
		}
	});

	it('resolves a relative request against baseURL, the way ofetch does', () => {
		expect(
			shouldAttachCsrfToken({
				request: 'update',
				method: 'POST',
				baseURL: '/api/system',
				href: HREF,
			})
		).toBe(true);
		expect(
			shouldAttachCsrfToken({
				request: 'collect',
				method: 'POST',
				baseURL: 'https://other.example/',
				href: HREF,
			})
		).toBe(false);
	});

	it('reads the url and the method off a Request instance', () => {
		// ofetch leaves a `Request`'s own method alone when no option overrides
		// it, so the rule has to read it from there too.
		expect(
			shouldAttachCsrfToken({
				request: new Request('https://mail.acme.test/api/system/update', { method: 'POST' }),
				href: HREF,
			})
		).toBe(true);
		expect(
			shouldAttachCsrfToken({
				request: new Request('https://mail.acme.test/api/system/update'),
				href: HREF,
			})
		).toBe(false);
	});

	it('declines an opaque origin, which compares equal to every other', () => {
		// The desktop shell renders from a custom scheme; `new URL(...).origin`
		// is the string "null" there, for the page and for the target alike.
		expect(
			shouldAttachCsrfToken({
				request: '/api/system/update',
				method: 'POST',
				href: 'tauri://localhost/dashboard',
			})
		).toBe(false);
	});

	it('declines anything it cannot resolve to a URL', () => {
		expect(shouldAttachCsrfToken({ request: {}, method: 'POST', href: HREF })).toBe(false);
		expect(shouldAttachCsrfToken({ request: '/api/x', method: 'POST', href: 'not a url' })).toBe(
			false
		);
	});
});

describe('readCsrfToken', () => {
	function doc(html: string): Pick<Document, 'querySelector'> {
		const el = document.createElement('div');
		el.innerHTML = html;
		return { querySelector: (selector: string) => el.querySelector(selector) } as Pick<
			Document,
			'querySelector'
		>;
	}

	it('reads the token the Nitro plugin renders into the head', () => {
		expect(readCsrfToken(doc('<meta name="csrf-token" content="tok-123">'))).toBe('tok-123');
	});

	it('returns null when the meta tag is absent or empty', () => {
		expect(readCsrfToken(doc(''))).toBeNull();
		expect(readCsrfToken(doc('<meta name="csrf-token" content="">'))).toBeNull();
	});
});

describe('withCsrfHeader', () => {
	it('adds the header without disturbing the rest of the options', () => {
		const options = { method: 'POST', body: { a: 1 }, headers: { 'X-Setup-Token': 'st' } };
		const next = withCsrfHeader(options, 'csrf-token', 'tok-123');

		const headers = next.headers as Headers;
		expect(headers.get('csrf-token')).toBe('tok-123');
		expect(headers.get('X-Setup-Token')).toBe('st');
		expect(next.method).toBe('POST');
		expect(next.body).toEqual({ a: 1 });
		// The caller's object is left alone — options are often reused objects.
		expect(options.headers).toEqual({ 'X-Setup-Token': 'st' });
	});

	it('accepts the other HeadersInit shapes', () => {
		expect((withCsrfHeader({}, 'csrf-token', 'tok').headers as Headers).get('csrf-token')).toBe(
			'tok'
		);
		const fromHeaders = withCsrfHeader(
			{ headers: new Headers({ accept: 'application/json' }) },
			'csrf-token',
			'tok'
		);
		expect((fromHeaders.headers as Headers).get('accept')).toBe('application/json');
	});

	it('never overwrites a header the caller set explicitly', () => {
		const next = withCsrfHeader({ headers: { 'csrf-token': 'mine' } }, 'csrf-token', 'tok-123');
		expect((next.headers as Headers).get('csrf-token')).toBe('mine');
	});
});

describe('isCsrfRejection', () => {
	it('recognizes the middleware error body', () => {
		expect(isCsrfRejection({ statusCode: 403, statusMessage: CSRF_REJECTION_STATUS_MESSAGE })).toBe(
			true
		);
	});

	it('leaves a route handler 403 alone', () => {
		expect(isCsrfRejection({ statusCode: 403, statusMessage: 'Forbidden' })).toBe(false);
		expect(isCsrfRejection(null)).toBe(false);
		expect(isCsrfRejection(undefined)).toBe(false);
		expect(isCsrfRejection('Setup mode is not active.')).toBe(false);
	});
});

describe('writeCsrfToken', () => {
	it('round-trips through readCsrfToken', () => {
		document.head.innerHTML = '<meta name="csrf-token" content="tok-stale">';
		writeCsrfToken(document, 'tok-fresh');
		expect(readCsrfToken(document)).toBe('tok-fresh');
		expect(document.head.querySelectorAll('meta[name="csrf-token"]')).toHaveLength(1);
	});

	it('creates the tag on a document rendered without one', () => {
		// A refreshed token can now reach a document that never carried one —
		// exactly the tab with no tag to update.
		document.head.innerHTML = '';
		writeCsrfToken(document, 'tok-fresh');
		expect(readCsrfToken(document)).toBe('tok-fresh');
	});
});
