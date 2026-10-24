import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IMAP_WIRE_MIN_SUPPORTED, IMAP_WIRE_VERSION } from '../imapWire';
import {
	WORKER_SERVICES,
	workerWireReportResult,
	workerWireVerdict,
	workerWireWindow,
} from '../workerWire';

describe('workerWireVerdict', () => {
	it('places a worker against its service window', () => {
		const window = { current: 3, minSupported: 2 };
		expect(workerWireVerdict(3, window)).toBe('current');
		expect(workerWireVerdict(2, window)).toBe('supported');
		expect(workerWireVerdict(1, window)).toBe('unsupported');
		expect(workerWireVerdict(4, window)).toBe('ahead');
	});
});

describe('workerWireWindow', () => {
	it("keeps the IMAP server's own constants", () => {
		expect(workerWireWindow('imap')).toEqual({
			current: IMAP_WIRE_VERSION,
			minSupported: IMAP_WIRE_MIN_SUPPORTED,
		});
	});

	it('still serves the releases from before reporting for the services that start reporting now', () => {
		for (const service of ['mail-sync', 'mta', 'code-worker'] as const) {
			expect(workerWireVerdict(0, workerWireWindow(service))).toBe('supported');
			expect(workerWireVerdict(1, workerWireWindow(service))).toBe('current');
		}
	});

	it('has a window for every service', () => {
		for (const service of WORKER_SERVICES) {
			const window = workerWireWindow(service);
			expect(window.minSupported).toBeLessThanOrEqual(window.current);
		}
	});

	it("matches the code-worker's own copy of its number", () => {
		// The code-worker image ships without this package, so it keeps the number itself.
		const source = readFileSync(
			new URL('../../../../apps/code-worker/src/wireVersion.ts', import.meta.url),
			'utf8'
		);
		const copy = /export const CODE_WORKER_WIRE_VERSION = (\d+);/.exec(source)?.[1];
		expect(Number(copy)).toBe(workerWireWindow('code-worker').current);
	});
});

describe('workerWireReportResult', () => {
	const window = { current: 3, minSupported: 2 };

	it('serves the current and supported contracts', () => {
		expect(workerWireReportResult(3, window)).toEqual({
			backendWireVersion: 3,
			minSupportedWireVersion: 2,
			compatible: true,
		});
		expect(workerWireReportResult(2, window)).toMatchObject({ compatible: true });
	});

	it('names why it does not serve the others', () => {
		expect(workerWireReportResult(1, window)).toMatchObject({
			compatible: false,
			reason: 'server_too_old',
		});
		expect(workerWireReportResult(4, window)).toMatchObject({
			compatible: false,
			reason: 'backend_older',
		});
	});
});
