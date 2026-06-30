import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { warnScanSkipped, _resetScannerWarnThrottle } from '../scannerHealth';

describe('warnScanSkipped', () => {
	beforeEach(() => {
		_resetScannerWarnThrottle();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('warns the operator on the first skip', () => {
		warnScanSkipped('invoice.pdf', 'ClamAV unavailable');
		expect(console.warn).toHaveBeenCalledTimes(1);
		expect((console.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatch(/UNSCANNED/);
	});

	it('throttles a burst of skips to one warning per window', () => {
		warnScanSkipped('a.pdf');
		warnScanSkipped('b.pdf');
		warnScanSkipped('c.pdf');
		expect(console.warn).toHaveBeenCalledTimes(1);
	});

	it('warns again after the throttle window elapses', () => {
		vi.useFakeTimers();
		vi.setSystemTime(100_000);
		warnScanSkipped('a.pdf');
		vi.setSystemTime(161_001); // past the 60s window
		warnScanSkipped('b.pdf');
		expect(console.warn).toHaveBeenCalledTimes(2);
	});
});
