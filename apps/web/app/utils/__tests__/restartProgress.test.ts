import { describe, it, expect } from 'vitest';
import {
	restartProgressPhase,
	restartStepStatus,
	RESTART_STEP_ORDER,
	RESTART_PHASE_COPY,
} from '../restartProgress';
import { createTestI18n } from '~/__tests__/i18n';

// The phase copy is a pure registry of message keys; the words a person reads
// come from the real catalog.
const { t } = createTestI18n().global;

describe('restartProgressPhase', () => {
	it('starts in "applying" for the first probes', () => {
		expect(restartProgressPhase({ pollCount: 0, ready: false })).toBe('applying');
		expect(restartProgressPhase({ pollCount: 1, ready: false })).toBe('applying');
	});

	it('moves to "restarting" once services should be reloading (~4s)', () => {
		expect(restartProgressPhase({ pollCount: 2, ready: false })).toBe('restarting');
		expect(restartProgressPhase({ pollCount: 5, ready: false })).toBe('restarting');
	});

	it('moves to "waiting" as it approaches the usual return time (~12s)', () => {
		expect(restartProgressPhase({ pollCount: 6, ready: false })).toBe('waiting');
		expect(restartProgressPhase({ pollCount: 11, ready: false })).toBe('waiting');
	});

	it('tips into "timeout" once the restart is unusually slow (~24s)', () => {
		expect(restartProgressPhase({ pollCount: 12, ready: false })).toBe('timeout');
		expect(restartProgressPhase({ pollCount: 50, ready: false })).toBe('timeout');
	});

	it('reports "done" the moment the probe clears, regardless of elapsed', () => {
		expect(restartProgressPhase({ pollCount: 0, ready: true })).toBe('done');
		expect(restartProgressPhase({ pollCount: 12, ready: true })).toBe('done');
		expect(restartProgressPhase({ pollCount: 99, ready: true })).toBe('done');
	});

	it('has human copy for every rendered phase (the terminal "done" renders none)', () => {
		const phases = ['applying', 'restarting', 'waiting', 'timeout'] as const;
		for (const p of phases) {
			// A key with no message would translate to the key path itself.
			expect(t(RESTART_PHASE_COPY[p].label)).not.toBe(RESTART_PHASE_COPY[p].label);
			expect(t(RESTART_PHASE_COPY[p].detail)).not.toBe(RESTART_PHASE_COPY[p].detail);
		}
		expect(t(RESTART_PHASE_COPY.applying.label)).toBe('Applying your configuration');
		expect(t(RESTART_PHASE_COPY.timeout.detail)).toBe('Still waiting for the app to come back.');
	});
});

describe('restartStepStatus', () => {
	it('spins the current step and completes the earlier ones', () => {
		expect(restartStepStatus('applying', 'restarting')).toBe('complete');
		expect(restartStepStatus('restarting', 'restarting')).toBe('active');
		expect(restartStepStatus('waiting', 'restarting')).toBe('pending');
	});

	it('keeps the final step active while timed out (restart truly not back yet)', () => {
		expect(restartStepStatus('applying', 'timeout')).toBe('complete');
		expect(restartStepStatus('restarting', 'timeout')).toBe('complete');
		expect(restartStepStatus('waiting', 'timeout')).toBe('active');
	});

	it('completes every step once done', () => {
		for (const step of RESTART_STEP_ORDER) {
			expect(restartStepStatus(step, 'done')).toBe('complete');
		}
	});

	it('shows only the first step active at the very start', () => {
		expect(restartStepStatus('applying', 'applying')).toBe('active');
		expect(restartStepStatus('restarting', 'applying')).toBe('pending');
		expect(restartStepStatus('waiting', 'applying')).toBe('pending');
	});
});
