import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConvexAuthRecovery } from '../convexAuthRecovery';

describe('createConvexAuthRecovery', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function setup(random = () => 0) {
		const reinstall = vi.fn();
		const onGiveUp = vi.fn();
		const onRecovered = vi.fn();
		const recovery = createConvexAuthRecovery({
			reinstall,
			onGiveUp,
			onRecovered,
			maxAttempts: 3,
			random,
		});
		return { recovery, reinstall, onGiveUp, onRecovered };
	}

	it('doubles the delay per attempt and gives up once after the cap', () => {
		const { recovery, reinstall, onGiveUp } = setup();
		for (const delay of [1_000, 2_000, 4_000]) {
			expect(recovery.retry('rejected')).toBe(true);
			vi.advanceTimersByTime(delay - 1);
			const before = reinstall.mock.calls.length;
			vi.advanceTimersByTime(1);
			expect(reinstall.mock.calls.length).toBe(before + 1);
		}
		expect(recovery.retry('rejected')).toBe(false);
		expect(recovery.retry('rejected')).toBe(false);
		expect(onGiveUp).toHaveBeenCalledOnce();
		expect(onGiveUp).toHaveBeenCalledWith('rejected');
		vi.advanceTimersByTime(60_000);
		expect(reinstall).toHaveBeenCalledTimes(3);
	});

	it('spreads the delay by up to half again', () => {
		const { recovery, reinstall } = setup(() => 0.999);
		recovery.retry('unreachable');
		vi.advanceTimersByTime(1_498);
		expect(reinstall).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(reinstall).toHaveBeenCalledOnce();
	});

	it('ignores a second failure while a re-install is scheduled', () => {
		const { recovery, reinstall } = setup();
		recovery.retry('unreachable');
		recovery.retry('unreachable');
		vi.advanceTimersByTime(10_000);
		expect(reinstall).toHaveBeenCalledOnce();
	});

	it('reset cancels the scheduled re-install and restores the full budget', () => {
		const { recovery, reinstall, onGiveUp, onRecovered } = setup();
		recovery.retry('unreachable');
		recovery.reset();
		vi.advanceTimersByTime(60_000);
		expect(reinstall).not.toHaveBeenCalled();
		expect(onRecovered).not.toHaveBeenCalled();

		for (let i = 0; i < 3; i++) {
			recovery.retry('unreachable');
			vi.advanceTimersByTime(60_000);
		}
		expect(recovery.retry('unreachable')).toBe(false);
		recovery.reset();
		expect(onRecovered).toHaveBeenCalledOnce();
		expect(recovery.retry('unreachable')).toBe(true);
		expect(onGiveUp).toHaveBeenCalledOnce();
	});

	it('resume re-installs only once the budget is spent, and keeps the notice until auth works', () => {
		const { recovery, reinstall, onGiveUp, onRecovered } = setup();
		recovery.resume();
		expect(reinstall).not.toHaveBeenCalled();

		const spend = () => {
			for (let i = 0; i < 3; i++) {
				recovery.retry('unreachable');
				vi.advanceTimersByTime(60_000);
			}
			return recovery.retry('unreachable');
		};
		expect(spend()).toBe(false);
		expect(reinstall).toHaveBeenCalledTimes(3);

		recovery.resume();
		recovery.resume();
		expect(reinstall).toHaveBeenCalledTimes(4);
		expect(onRecovered).not.toHaveBeenCalled();

		// The resumed streak fails as well: bounded again, reported only once.
		expect(spend()).toBe(false);
		expect(reinstall).toHaveBeenCalledTimes(7);
		expect(onGiveUp).toHaveBeenCalledOnce();

		recovery.reset();
		expect(onRecovered).toHaveBeenCalledOnce();
	});
});
