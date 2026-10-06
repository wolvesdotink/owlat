/**
 * Memory of the server's forward read (#1257): `fulfil` locates and decodes a
 * forwarded message's parts over its bytes (`locateForwardedParts`), so the
 * read stays within a Node action's 512 MiB whatever the message holds. Each
 * input runs in its own Node process (`helpers/forwardMemoryProbe.ts`), which
 * reports that process's peak resident memory:
 *
 *  - 64 MiB of base64: over `MAX_FORWARD_RAW_BYTES`, never read;
 *  - 50 MiB of base64 (the largest message any path stores): read, its one
 *    part over the per-file limit counted but not decoded;
 *  - 33 MiB of base64: read, its part (just under the limit) decoded and stored;
 *  - 8 MiB of quoted-printable `=41` lines, which took the old string path
 *    past 570 MiB.
 *
 * About a minute of child processes, so it runs only with
 * OWLAT_MEMORY_TESTS=1 (`OWLAT_MEMORY_TESTS=1 npx vitest run
 * src/__tests__/forwardMemory.test.ts`), like the repository's other opt-in
 * suites.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PROBE = join(import.meta.dirname, 'helpers/forwardMemoryProbe.ts');
/** Well under a Node action's 512 MiB, with the probe's ~85 MiB of loader overhead included. */
const PEAK_LIMIT_MIB = 320;

function probe(name: string): {
	peakMiB: number;
	read: boolean;
	refused: number;
	decodedMiB: number;
} {
	const out = execFileSync(process.execPath, ['--expose-gc', '--import', 'tsx', PROBE, name], {
		cwd: join(import.meta.dirname, '../..'),
		encoding: 'utf8',
	});
	return JSON.parse(out);
}

describe.skipIf(process.env['OWLAT_MEMORY_TESTS'] !== '1')('forward read memory', () => {
	it('does not read a message over the limit at all', () => {
		const result = probe('base64-64MiB');
		expect(result.read).toBe(false);
		expect(result.peakMiB).toBeLessThan(PEAK_LIMIT_MIB);
	});

	it('reads the largest stored message without decoding a part over the per-file limit', () => {
		const result = probe('base64-50MiB');
		expect(result).toMatchObject({ read: true, refused: 1, decodedMiB: 0 });
		expect(result.peakMiB).toBeLessThan(PEAK_LIMIT_MIB);
	});

	it('decodes and stores a part just under the per-file limit', () => {
		const result = probe('base64-33MiB');
		expect(result.decodedMiB).toBeGreaterThan(24);
		expect(result.peakMiB).toBeLessThan(PEAK_LIMIT_MIB);
	});

	it('decodes pathological quoted-printable without blowing up', () => {
		const result = probe('qp-8MiB');
		expect(result.decodedMiB).toBeGreaterThan(2.5);
		expect(result.peakMiB).toBeLessThan(PEAK_LIMIT_MIB);
	});
});
