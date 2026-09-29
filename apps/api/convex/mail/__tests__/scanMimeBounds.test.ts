/**
 * The inbound malware scan when the MIME walker's depth or part bound leaves
 * part of a message unwalked (GHSA-72gq-2gg3-2vqq).
 *
 * Leaves past the bound never reach the candidate list, yet the raw message is
 * stored and served whole, so a mail client still shows them. The scan must
 * not answer `'clean'` (or `undefined`, "nothing to scan") for such a message:
 * the unwalked remainder counts as one unscanned leaf and the verdict is
 * `'skipped'`. A bounded message that fits the walker is unaffected.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MAX_MIME_PARTS } from '@owlat/mail-message';
import { scanInboundAttachments } from '../deliveryPipeline/scan';
import * as scannerHealth from '../../lib/scannerHealth';
import { readScanRequest } from './scannerStub.testlib';

const MTA = { baseUrl: 'https://mta.test', apiKey: 'secret' };

function attachment(filename: string): string[] {
	return [
		'Content-Type: application/octet-stream',
		`Content-Disposition: attachment; filename="${filename}"`,
		'',
		`bytes of ${filename}`,
	];
}

function filler(i: number): string[] {
	return ['Content-Type: text/plain', '', `filler ${i}`];
}

/** A flat multipart/mixed message whose parts are given as header+body lines. */
function flatMessage(parts: string[][]): string {
	const lines = [
		'Subject: bounds',
		'MIME-Version: 1.0',
		'Content-Type: multipart/mixed; boundary="X"',
		'',
	];
	for (const part of parts) lines.push('--X', ...part);
	lines.push('--X--', '');
	return lines.join('\r\n');
}

function fillers(count: number): string[][] {
	return Array.from({ length: count }, (_, i) => filler(i));
}

/** One attachment nested `levels` multipart containers deep. */
function nestedMessage(levels: number, filename: string): string {
	const open: string[] = ['Subject: bounds', 'MIME-Version: 1.0'];
	const close: string[] = [];
	for (let i = 0; i < levels; i++) {
		open.push(`Content-Type: multipart/mixed; boundary="n${i}"`, '', `--n${i}`);
		close.unshift(`--n${i}--`);
	}
	return [...open, ...attachment(filename), ...close, ''].join('\r\n');
}

function stubCleanScanner(): string[] {
	const scanned: string[] = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
		scanned.push(readScanRequest(url, init as RequestInit | undefined).filename);
		return new Response(JSON.stringify({ clean: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	});
	return scanned;
}

describe('scanInboundAttachments past the MIME walker bounds', () => {
	beforeEach(() => {
		scannerHealth._resetScannerWarnThrottle();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('does not report "nothing to scan" when the part budget ends before an attachment', async () => {
		const scanned = stubCleanScanner();
		const raw = flatMessage([...fillers(MAX_MIME_PARTS), attachment('late.bin')]);
		const scan = await scanInboundAttachments(MTA, raw);
		expect(scan.candidates).toEqual([]);
		expect(scanned).toEqual([]);
		expect(scan.verdict).toBe('skipped');
		expect(scan.uncleared).toEqual({ capped: 0, unscanned: 1, refusedType: 0 });
		expect(scan.cleanParts).toEqual([]);
	});

	it('does not report "nothing to scan" when an attachment sits past the depth bound', async () => {
		const scanned = stubCleanScanner();
		const scan = await scanInboundAttachments(MTA, nestedMessage(101, 'deep.bin'));
		expect(scan.candidates).toEqual([]);
		expect(scanned).toEqual([]);
		expect(scan.verdict).toBe('skipped');
		expect(scan.uncleared.unscanned).toBe(1);
	});

	it('does not answer "clean" when only the leaves inside the bound were scanned', async () => {
		const scanned = stubCleanScanner();
		const raw = flatMessage([
			attachment('early.txt'),
			...fillers(MAX_MIME_PARTS),
			attachment('late.bin'),
		]);
		const scan = await scanInboundAttachments(MTA, raw);
		expect(scanned).toEqual(['early.txt']);
		expect(scan.cleanParts.map((part) => part.filename)).toEqual(['early.txt']);
		expect(scan.verdict).toBe('skipped');
		expect(scan.uncleared).toEqual({ capped: 0, unscanned: 1, refusedType: 0 });
		expect(scan.scannerAnswered).toBe(true);
	});

	it('marks an unwalked remainder as skipped with no scanner and a clean upstream verdict', async () => {
		const raw = flatMessage([...fillers(MAX_MIME_PARTS), attachment('late.bin')]);
		expect((await scanInboundAttachments(null, raw)).verdict).toBe('skipped');
		expect((await scanInboundAttachments(null, raw, 'clean')).verdict).toBe('skipped');
		expect((await scanInboundAttachments(null, raw, 'infected')).verdict).toBe('infected');
	});

	it('still answers "clean" for a message that fits the walker exactly', async () => {
		const scanned = stubCleanScanner();
		const raw = flatMessage([...fillers(MAX_MIME_PARTS - 1), attachment('last.txt')]);
		const scan = await scanInboundAttachments(MTA, raw);
		expect(scanned).toEqual(['last.txt']);
		expect(scan.verdict).toBe('clean');
		expect(scan.uncleared).toEqual({ capped: 0, unscanned: 0, refusedType: 0 });
		const deep = await scanInboundAttachments(MTA, nestedMessage(100, 'deep.txt'));
		expect(deep.verdict).toBe('clean');
	});
});
