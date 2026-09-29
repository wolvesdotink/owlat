import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanInboundAttachments } from '../deliveryPipeline/scan';
import { readScanRequest } from './scannerStub.testlib';

/**
 * The inbound scan sends a message's attachment leaves to the scanner a few at
 * a time instead of one after another, keeps the verdicts in MIME order, and
 * stops sending leaves once one comes back infected.
 */

const MTA = { baseUrl: 'https://mta.test', apiKey: 'secret' };

function emlWithLeaves(filenames: string[]): string {
	const lines = [
		'From: sender@isp.example',
		'To: me@example.com',
		'Subject: many leaves',
		'Message-ID: <many@isp.example>',
		'MIME-Version: 1.0',
		'Content-Type: multipart/mixed; boundary="B"',
		'',
		'--B',
		'Content-Type: text/plain; charset=utf-8',
		'',
		'see attached',
	];
	for (const filename of filenames) {
		lines.push(
			'--B',
			`Content-Type: application/octet-stream; name="${filename}"`,
			`Content-Disposition: attachment; filename="${filename}"`,
			'Content-Transfer-Encoding: base64',
			'',
			Buffer.from(`bytes of ${filename}`, 'utf-8').toString('base64')
		);
	}
	lines.push('--B--', '');
	return lines.join('\r\n');
}

type Verdict = { clean: boolean; virus?: string };

/** A scanner whose answers the test releases by hand. */
function heldScanner() {
	const pending: Array<{
		filename: string;
		signal?: AbortSignal | null;
		answer: (v: Verdict) => void;
	}> = [];
	let inFlight = 0;
	let peak = 0;
	vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
		const request = readScanRequest(url, init as RequestInit | undefined);
		inFlight += 1;
		peak = Math.max(peak, inFlight);
		return new Promise<Response>((resolve) => {
			pending.push({
				filename: request.filename,
				signal: (init as RequestInit | undefined)?.signal,
				answer: (verdict) => {
					inFlight -= 1;
					resolve(new Response(JSON.stringify(verdict), { status: 200 }));
				},
			});
		});
	});
	return { pending, peak: () => peak };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
	vi.restoreAllMocks();
});

describe('scanInboundAttachments — concurrency', () => {
	it('scans four leaves at a time and keeps the cleared parts in MIME order', async () => {
		const scanner = heldScanner();
		const names = Array.from({ length: 8 }, (_, i) => `doc${i}.txt`);

		const run = scanInboundAttachments(MTA, emlWithLeaves(names));
		await flush();
		// Four open at once, not one.
		expect(scanner.pending.map((p) => p.filename)).toEqual(names.slice(0, 4));
		for (const p of scanner.pending) expect(p.signal).toBeInstanceOf(AbortSignal);

		// Answer the later ones first; order of arrival must not reorder the result.
		for (const p of [...scanner.pending].reverse()) p.answer({ clean: true });
		await flush();
		expect(scanner.pending).toHaveLength(8);
		for (const p of scanner.pending.slice(4)) p.answer({ clean: true });

		const scan = await run;
		expect(scanner.peak()).toBe(4);
		expect(scan.verdict).toBe('clean');
		expect(scan.cleanParts.map((p) => p.filename)).toEqual(names);
	});

	it('quarantines on an infection and sends no further leaf to the scanner', async () => {
		const scanner = heldScanner();
		const names = Array.from({ length: 8 }, (_, i) => `doc${i}.txt`);

		const run = scanInboundAttachments(MTA, emlWithLeaves(names));
		await flush();
		scanner.pending[1]!.answer({ clean: false, virus: 'Eicar-Signature' });
		await flush();
		for (const p of [scanner.pending[0]!, ...scanner.pending.slice(2)]) p.answer({ clean: true });

		const scan = await run;
		expect(scan.verdict).toBe('infected');
		expect(scan.cleanParts).toHaveLength(0);
		// Only the four already in flight were ever sent.
		expect(scanner.pending).toHaveLength(4);
	});
});
