/**
 * RFC 8058 One-Click unsubscribe POST — `postOneClickUnsubscribe` (fetch-spy).
 *
 * The URL comes from an attacker-controlled List-Unsubscribe header, so the
 * pure wrapper must (1) refuse to fetch anything the shared SSRF guard
 * rejects, (2) send exactly the RFC 8058 form POST without following
 * redirects, and (3) fail SOFT — network errors / timeouts / non-2xx come
 * back as `{ ok: false }`, never a throw (the chip shows a toast and the
 * message is left untouched).
 */

import { describe, it, expect, vi } from 'vitest';
import { postOneClickUnsubscribe, ONE_CLICK_TIMEOUT_MS } from '../unsubscribe';

describe('postOneClickUnsubscribe', () => {
	it('POSTs the RFC 8058 form body and reports success on 2xx', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
		const result = await postOneClickUnsubscribe(
			'https://news.example.com/unsub?u=abc',
			fetchSpy as unknown as typeof fetch,
		);
		expect(result).toEqual({ ok: true });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0]!;
		expect(url).toBe('https://news.example.com/unsub?u=abc');
		expect(init.method).toBe('POST');
		expect(init.body).toBe('List-Unsubscribe=One-Click');
		expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
		// Redirects are not followed — the SSRF guard vetted only this URL.
		expect(init.redirect).toBe('manual');
		// Bounded wait: an AbortSignal is always attached.
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it('never fetches an http URL', async () => {
		const fetchSpy = vi.fn();
		const result = await postOneClickUnsubscribe(
			'http://news.example.com/unsub',
			fetchSpy as unknown as typeof fetch,
		);
		expect(result).toEqual({ ok: false, error: 'unsafe_url' });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('never fetches a private-IP / IP-literal URL (SSRF guard)', async () => {
		const fetchSpy = vi.fn();
		for (const url of [
			'https://127.0.0.1/unsub',
			'https://10.0.0.5/unsub',
			'https://169.254.169.254/latest/meta-data',
			'https://[::1]/unsub',
			'https://localhost/unsub',
		]) {
			const result = await postOneClickUnsubscribe(url, fetchSpy as unknown as typeof fetch);
			expect(result).toEqual({ ok: false, error: 'unsafe_url' });
		}
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('fails soft on a non-2xx response', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(new Response('nope', { status: 503 }));
		const result = await postOneClickUnsubscribe(
			'https://news.example.com/unsub',
			fetchSpy as unknown as typeof fetch,
		);
		expect(result).toEqual({ ok: false, error: 'http_503' });
	});

	it('fails soft on a network error / timeout (never throws)', async () => {
		const fetchSpy = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
		const result = await postOneClickUnsubscribe(
			'https://news.example.com/unsub',
			fetchSpy as unknown as typeof fetch,
		);
		expect(result).toEqual({ ok: false, error: 'network' });
	});

	it('keeps the timeout bounded', () => {
		expect(ONE_CLICK_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
	});
});
