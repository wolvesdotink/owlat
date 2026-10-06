/**
 * Memory of the server's forward read (#1257). `fulfil` reads a forwarded
 * message by streaming and unsealing it into one array
 * (`readSealedBlobBytesStreaming`), locates its parts over those bytes with
 * header budgets (`locateMimeTree`), and decodes only the parts it forwards,
 * one at a time, in constant extra memory. This holds that path to well under
 * a Node action's 512 MiB for adversarial messages just under the raw-size
 * gate (and one over it, which is not read). Each input is written by one
 * Node process and read by another (`helpers/forwardMemoryProbe.ts`), which
 * reports its peak resident memory, about 85 MiB of it Node and tsx.
 *
 * About two minutes of child processes, so it runs only with
 * OWLAT_MEMORY_TESTS=1 (`OWLAT_MEMORY_TESTS=1 npx vitest run
 * convex/__tests__/forwardMemory.test.ts`), like the repository's other
 * opt-in suites.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PROBE = join(import.meta.dirname, 'helpers/forwardMemoryProbe.ts');
const PEAK_LIMIT_MIB = 320;
const SECONDS_LIMIT = 10;

interface ProbeResult {
	read: boolean;
	seconds: number;
	peakMiB: number;
	parts: number;
	decodedMiB: number;
	refused: number;
	truncated: boolean;
}

function run(args: string[], gc = false): string {
	return execFileSync(
		process.execPath,
		[...(gc ? ['--expose-gc'] : []), '--import', 'tsx', PROBE, ...args],
		{ cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' }
	);
}

function probe(input: string, sealing: 'sealed' | 'plain' = 'sealed'): ProbeResult {
	const dir = mkdtempSync(join(tmpdir(), 'owlat-forward-memory-'));
	try {
		run(['write', input, dir, sealing]);
		return JSON.parse(run(['read', dir, sealing], true)) as ProbeResult;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Every shape that takes a distinct path through the read, and what it must do. */
const SHAPES: Array<[string, Partial<ProbeResult>]> = [
	['base64-64MiB', { read: false }],
	['base64-50MiB', { read: true, refused: 1 }],
	['base64-33MiB', { read: true, refused: 0 }],
	['qp-8MiB', { read: true, refused: 0 }],
	['qp-escapes-soft-breaks', { read: true, refused: 0 }],
	['qp-soft-breaks-only', { read: true }],
	['qp-mixed', { read: true }],
	['qp-invalid-escapes', { read: true }],
	['qp-equals-to-the-end', { read: true }],
	['base64-whitespace', { read: true }],
	['base64-garbage', { read: true }],
	['base64-no-padding', { read: true }],
	['headers-no-separator', { read: true, truncated: true }],
	['headers-then-body', { read: true, truncated: true }],
	['header-folded-long', { read: true, truncated: true }],
	['parts-many-tiny-headers', { read: true, truncated: true }],
	['parts-tiny-with-big-headers', { read: true, truncated: true }],
	['long-line-no-crlf', { read: true }],
	['nested-depth-100', { read: true, truncated: false }],
	['boundary-text-in-body', { read: true, truncated: false }],
	// RFC 2231 indexes far past any real one, on every part: the walk stops at
	// the part bound, never at an index.
	['continuation-indexes', { read: true, truncated: true }],
];

describe.skipIf(process.env['OWLAT_MEMORY_TESTS'] !== '1')('forward read memory', () => {
	it.each(SHAPES)('%s', (input, expected) => {
		const result = probe(input);
		expect(result).toMatchObject(expected);
		expect(result.peakMiB).toBeLessThan(PEAK_LIMIT_MIB);
		// Node and tsx start-up included: the read itself is well under this.
		expect(result.seconds).toBeLessThan(SECONDS_LIMIT);
	});

	it('reads a legacy plaintext blob within the same bound', () => {
		const result = probe('qp-escapes-soft-breaks', 'plain');
		expect(result.read).toBe(true);
		expect(result.peakMiB).toBeLessThan(PEAK_LIMIT_MIB);
	});
});
