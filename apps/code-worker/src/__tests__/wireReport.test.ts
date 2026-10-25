/**
 * The code-worker's wire-version report: at start and every interval, through
 * its own `reportCodeWorker` entry point, with the release from OWLAT_VERSION,
 * a logged line for anything but a served contract, and a stop.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { wireFn, type CodeWorkerWireReportResult } from '../convexClient.js';
import { CODE_WORKER_WIRE_VERSION } from '../wireVersion.js';
import { describeWireReport, startWireReports, WIRE_REPORT_INTERVAL_MS } from '../wireReport.js';

const served: CodeWorkerWireReportResult = {
	backendWireVersion: 1,
	minSupportedWireVersion: 0,
	compatible: true,
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

function start(report: (args: unknown) => Promise<CodeWorkerWireReportResult>) {
	let tick: (() => void) | undefined;
	const clearInterval = vi.fn();
	const log = vi.fn();
	const handle = startWireReports({
		report,
		log,
		now: () => 42,
		setInterval: (callback, ms) => {
			expect(ms).toBe(WIRE_REPORT_INTERVAL_MS);
			tick = callback;
			return { unref: vi.fn() };
		},
		clearInterval,
	});
	return { handle, log, clearInterval, fire: () => tick?.() };
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('startWireReports', () => {
	it('reports its process at start and every interval, until stopped', async () => {
		vi.stubEnv('OWLAT_VERSION', '0.6.17');
		const report = vi.fn().mockResolvedValue(served);
		const { handle, log, clearInterval, fire } = start(report);
		await settle();
		expect(report).toHaveBeenCalledTimes(1);
		expect(report.mock.calls[0]![0]).toMatchObject({
			owlatVersion: '0.6.17',
			wireVersion: CODE_WORKER_WIRE_VERSION,
			startedAt: 42,
		});
		expect(log).not.toHaveBeenCalled();

		fire();
		await settle();
		expect(report).toHaveBeenCalledTimes(2);
		// The same process identity on every report.
		expect(report.mock.calls[1]![0]).toEqual(report.mock.calls[0]![0]);

		handle.stop();
		expect(clearInterval).toHaveBeenCalledTimes(1);
		fire();
		await settle();
		expect(report).toHaveBeenCalledTimes(2);
	});

	it('logs a failed report and tries again at the next interval', async () => {
		const report = vi
			.fn()
			.mockRejectedValueOnce(new Error('proxy said 403'))
			.mockResolvedValue(served);
		const { log, fire } = start(report);
		await settle();
		expect(log).toHaveBeenCalledWith(expect.stringContaining('proxy said 403'));
		fire();
		await settle();
		expect(report).toHaveBeenCalledTimes(2);
	});

	it('calls the code-worker entry point, never the generic report', () => {
		expect(getFunctionName(wireFn.report)).toBe('maintenance/workerRegistry:reportCodeWorker');
	});
});

describe('describeWireReport', () => {
	it('is silent while the backend serves this worker', () => {
		expect(describeWireReport(served, 1)).toBeNull();
		expect(describeWireReport({ ...served, backendWireVersion: 2 }, 1)).toBeNull();
	});

	it('names what to update otherwise', () => {
		expect(describeWireReport({ ...served, backendWireVersion: 0 }, 1)).toContain(
			'Update the backend first'
		);
		expect(
			describeWireReport(
				{ backendWireVersion: 3, minSupportedWireVersion: 2, compatible: false },
				1
			)
		).toContain('Update the code-worker image');
	});
});
