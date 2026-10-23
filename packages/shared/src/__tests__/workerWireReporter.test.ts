import { describe, expect, it, vi } from 'vitest';
import { WORKER_REPORT_INTERVAL_MS, type WorkerWireReportResult } from '../workerWire';
import {
	startWorkerWireReports,
	workerReportIdentity,
	type WorkerWireReporterDeps,
} from '../workerWireReporter';

const served: WorkerWireReportResult = {
	backendWireVersion: 1,
	minSupportedWireVersion: 0,
	compatible: true,
};

/** A manual interval: the test fires each tick itself, no clock involved. */
function manualTimer() {
	let callback: (() => void) | undefined;
	let cleared = false;
	return {
		setInterval: vi.fn((cb: () => void, ms: number) => {
			expect(ms).toBe(WORKER_REPORT_INTERVAL_MS);
			callback = cb;
			return { unref: vi.fn() };
		}),
		clearInterval: vi.fn(() => {
			cleared = true;
		}),
		fire: () => callback?.(),
		get cleared() {
			return cleared;
		},
	};
}

function reporter(report: WorkerWireReporterDeps['report']) {
	const timer = manualTimer();
	const log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const handle = startWorkerWireReports({
		service: 'mail-sync',
		wireVersion: 1,
		owlatVersion: '0.6.17',
		report,
		log,
		setInterval: timer.setInterval,
		clearInterval: timer.clearInterval,
	});
	return { handle, timer, log };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('startWorkerWireReports', () => {
	it('reports at start and at every interval, and stops on request', async () => {
		const report = vi.fn().mockResolvedValue(served);
		const { handle, timer, log } = reporter(report);
		await settle();
		expect(report).toHaveBeenCalledTimes(1);
		expect(log.debug).toHaveBeenCalledWith(
			expect.objectContaining({ service: 'mail-sync', backendWireVersion: 1 }),
			'Wire version report accepted'
		);

		timer.fire();
		await settle();
		expect(report).toHaveBeenCalledTimes(2);

		handle.stop();
		expect(timer.cleared).toBe(true);
		timer.fire();
		await settle();
		expect(report).toHaveBeenCalledTimes(2);
	});

	it('does not start a second report while one is in flight', async () => {
		let resolve: (value: WorkerWireReportResult) => void = () => {};
		const report = vi.fn(() => new Promise<WorkerWireReportResult>((r) => (resolve = r)));
		const { timer } = reporter(report);
		timer.fire();
		expect(report).toHaveBeenCalledTimes(1);
		resolve(served);
		await settle();
		timer.fire();
		expect(report).toHaveBeenCalledTimes(2);
	});

	it('logs a failed report and keeps going', async () => {
		const report = vi
			.fn()
			.mockRejectedValueOnce(new Error('ECONNREFUSED'))
			.mockResolvedValue(served);
		const { timer, log } = reporter(report);
		await settle();
		expect(log.warn).toHaveBeenCalledWith(
			expect.objectContaining({ err: expect.any(Error) }),
			expect.stringContaining('Could not report the wire version')
		);
		timer.fire();
		await settle();
		expect(log.debug).toHaveBeenCalled();
	});

	it('names what to update when the backend does not serve this worker', async () => {
		const tooOld = reporter(
			vi.fn().mockResolvedValue({
				backendWireVersion: 3,
				minSupportedWireVersion: 2,
				compatible: false,
				reason: 'server_too_old',
			})
		);
		await settle();
		expect(tooOld.log.error).toHaveBeenCalledWith(
			expect.objectContaining({ minSupportedWireVersion: 2 }),
			expect.stringContaining("Update this container to the backend's release.")
		);

		const ahead = reporter(vi.fn().mockResolvedValue({ ...served, backendWireVersion: 0 }));
		await settle();
		expect(ahead.log.error).toHaveBeenCalledWith(
			expect.objectContaining({ backendWireVersion: 0 }),
			expect.stringContaining('Update the backend first')
		);
	});
});

describe('an unexplained refusal', () => {
	it('is still a refusal', async () => {
		const { log } = reporter(vi.fn().mockResolvedValue({ ...served, compatible: false }));
		await settle();
		expect(log.error).toHaveBeenCalledWith(
			expect.anything(),
			expect.stringContaining('is older than the backend supports')
		);
	});
});

describe('workerReportIdentity', () => {
	it('reads the release from OWLAT_VERSION, dev when unset or empty', () => {
		expect(workerReportIdentity({ OWLAT_VERSION: '0.6.17' }, 5).owlatVersion).toBe('0.6.17');
		expect(workerReportIdentity({ OWLAT_VERSION: '' }, 5).owlatVersion).toBe('dev');
		const identity = workerReportIdentity({}, 5);
		expect(identity).toMatchObject({ owlatVersion: 'dev', startedAt: 5 });
		expect(identity.instanceId).not.toBe(workerReportIdentity({}, 5).instanceId);
	});
});
