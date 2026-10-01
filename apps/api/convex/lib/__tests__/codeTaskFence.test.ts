import { describe, it, expect } from 'vitest';
import { codeTaskWorkerVerdict } from '../codeTaskFence';

describe('codeTaskWorkerVerdict', () => {
	it('accepts the live attempt of a worker-owned task', () => {
		expect(codeTaskWorkerVerdict({ status: 'running', attempts: 2 }, 2)).toEqual({ ok: true });
		expect(codeTaskWorkerVerdict({ status: 'testing', attempts: 2 }, 2)).toEqual({ ok: true });
	});

	it('refuses a cancelled task, whatever attempt asks', () => {
		const cancelled = { status: 'failed' as const, attempts: 1, cancelledAt: 1 };
		expect(codeTaskWorkerVerdict(cancelled, 1)).toEqual({ ok: false, reason: 'cancelled' });
		expect(codeTaskWorkerVerdict(cancelled, undefined)).toEqual({
			ok: false,
			reason: 'cancelled',
		});
	});

	it('refuses an attempt that a newer claim superseded', () => {
		expect(codeTaskWorkerVerdict({ status: 'running', attempts: 2 }, 1)).toEqual({
			ok: false,
			reason: 'stale',
		});
	});

	it('refuses a task that already left the worker-owned statuses', () => {
		for (const status of ['queued', 'review', 'merged', 'failed'] as const) {
			expect(codeTaskWorkerVerdict({ status, attempts: 1 }, 1)).toEqual({
				ok: false,
				reason: 'finished',
			});
		}
		expect(codeTaskWorkerVerdict(null, 1)).toEqual({ ok: false, reason: 'missing' });
	});

	it('holds a call without an attempt (previous-release worker) to the status check only', () => {
		expect(codeTaskWorkerVerdict({ status: 'running', attempts: 5 }, undefined)).toEqual({
			ok: true,
		});
		expect(codeTaskWorkerVerdict({ status: 'review', attempts: 5 }, undefined)).toEqual({
			ok: false,
			reason: 'finished',
		});
	});
});
