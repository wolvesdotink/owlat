/**
 * MTA attachment-scan client (helper) — `mail/mtaClient.ts` `scanAttachmentBytes`.
 *
 * The three outbound/inbound scan sites (postbox outbound, inbound delivery,
 * campaign worker) used to inline the identical `/scan/attachment` POST +
 * fail-open three times — and had drifted on config plumbing. This pins the
 * single client:
 *   - SUCCESS: a clean verdict round-trips; an infected verdict surfaces the
 *     reason WITHOUT throwing (the gating policy stays at the call site).
 *   - SCANNER-DOWN FAIL-OPEN: a not-configured MTA, an HTTP error, and a
 *     network/parse error all resolve to `'skipped'` (never throw), so ClamAV
 *     unavailability can't wedge a send/deliver path.
 *
 * Pure over its `mta` arg, so a plain `fetch` spy is enough — no convex-test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scanAttachmentBytes } from '../mail/mtaClient';
import * as scannerHealth from '../lib/scannerHealth';

const MTA = { baseUrl: 'https://mta.test', apiKey: 'secret' };
const DATA = Buffer.from('attachment bytes');

interface ScanResponseBody {
	clean: boolean;
	virus?: string;
	reason?: string;
	skipped?: boolean;
}

/** Spy `fetch` returning a canned `/scan/attachment` body or an HTTP error. */
function mockScan(response: ScanResponseBody | { httpStatus: number }): {
	calls: Array<{ url: string; filename?: string; auth?: string }>;
} {
	const calls: Array<{ url: string; filename?: string; auth?: string }> = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
		const headers = (init as RequestInit | undefined)?.headers as
			| Record<string, string>
			| undefined;
		calls.push({
			url: String(url),
			filename: headers?.['X-Filename'],
			auth: headers?.['Authorization'],
		});
		if ('httpStatus' in response) {
			return new Response('scanner down', { status: response.httpStatus });
		}
		return new Response(JSON.stringify(response), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	});
	return { calls };
}

describe('scanAttachmentBytes', () => {
	beforeEach(() => {
		scannerHealth._resetScannerWarnThrottle();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('SUCCESS: a clean verdict round-trips and the POST is well-formed', async () => {
		const { calls } = mockScan({ clean: true });

		const verdict = await scanAttachmentBytes(MTA, 'invoice.pdf', DATA);

		expect(verdict).toEqual({ kind: 'clean' });
		// The POST hit the right endpoint with the bearer + filename headers.
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe('https://mta.test/scan/attachment');
		expect(calls[0]?.filename).toBe('invoice.pdf');
		expect(calls[0]?.auth).toBe('Bearer secret');
	});

	it('SUCCESS: an infected verdict surfaces the reason and does NOT throw', async () => {
		mockScan({ clean: false, virus: 'Eicar-Signature' });

		const verdict = await scanAttachmentBytes(MTA, 'eicar.com', DATA);

		// The client classifies but does not gate — the caller decides what to do.
		expect(verdict).toEqual({ kind: 'infected', reason: 'Eicar-Signature' });
	});

	it('SUCCESS: an explicit skipped verdict fails open and surfaces the skip', async () => {
		const warnSpy = vi.spyOn(scannerHealth, 'warnScanSkipped');
		mockScan({ clean: false, skipped: true, reason: 'too large' });

		const verdict = await scanAttachmentBytes(MTA, 'big.bin', DATA);

		expect(verdict).toEqual({ kind: 'skipped', reason: 'too large' });
		expect(warnSpy).toHaveBeenCalledWith('big.bin', 'too large');
	});

	it('FAIL-OPEN: a not-configured MTA resolves to skipped without a fetch', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');

		const verdict = await scanAttachmentBytes(null, 'invoice.pdf', DATA);

		expect(verdict).toEqual({ kind: 'skipped' });
		// Not configured → no network call at all (and silent, by design).
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('FAIL-OPEN: scanner-down (HTTP 503) resolves to skipped and is surfaced', async () => {
		const warnSpy = vi.spyOn(scannerHealth, 'warnScanSkipped');
		mockScan({ httpStatus: 503 });

		const verdict = await scanAttachmentBytes(MTA, 'invoice.pdf', DATA);

		expect(verdict.kind).toBe('skipped');
		expect(warnSpy).toHaveBeenCalled();
		expect(String(warnSpy.mock.calls[0]?.[1])).toContain('HTTP 503');
	});

	it('FAIL-OPEN: a network/parse error resolves to skipped and is surfaced', async () => {
		const warnSpy = vi.spyOn(scannerHealth, 'warnScanSkipped');
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

		const verdict = await scanAttachmentBytes(MTA, 'invoice.pdf', DATA);

		expect(verdict).toEqual({ kind: 'skipped', reason: 'ECONNREFUSED' });
		expect(warnSpy).toHaveBeenCalled();
	});
});
