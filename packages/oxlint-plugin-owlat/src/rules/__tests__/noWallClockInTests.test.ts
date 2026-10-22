import rule from '../noWallClockInTests.ts';
import { ruleTester } from '../../__tests__/ruleTester.ts';

const filename = 'cases.test.ts';
const vitest = "import { it, vi } from 'vitest';\n";
const elapsed = /^Elapsed wall-clock time in a test/;
const stopwatch = /^Stopwatch in a test/;

ruleTester.run('owlat/no-wall-clock-in-tests', rule, {
	valid: [
		{
			name: 'a stopwatch outside test files',
			filename: 'src/metrics.ts',
			code: 'const started = performance.now();\nexport const took = () => performance.now() - started;',
		},
		{
			name: 'a test file that reads no clock',
			filename,
			code: `${vitest}it('adds', () => { expect(1 + 1).toBe(2); });`,
		},
		{
			name: 'fixture timestamps: one reading, offsets and stored values',
			filename,
			code: `${vitest}const DAY = 86_400_000;\nit('seeds', () => { const now = Date.now(); seed({ createdAt: now, expiresAt: now + DAY, seenAt: Date.now() - DAY }); expect(row.createdAt).toBeLessThan(now); expect(now - DAY).toBeGreaterThan(0); });`,
		},
		{
			name: 'a value derived from a stored reading is a fixture, not a reading',
			filename,
			code: `${vitest}it('ages', () => { const now = Date.now(); const weekAgo = now - 7 * DAY; expect(now - weekAgo).toBe(7 * DAY); });`,
		},
		{
			name: 'a reading compared with a row field',
			filename,
			code: `${vitest}it('stamps', () => { expect(Date.now() - row.createdAt).toBeGreaterThanOrEqual(0); });`,
		},
		{
			name: 'differences on a pinned fake clock',
			filename,
			code: `${vitest}it('advances', () => { vi.setSystemTime(0); const start = Date.now(); vi.advanceTimersByTime(100); expect(Date.now() - start).toBe(100); });`,
		},
		{
			name: 'readings after a pin with Date faked, or with fake timers off (the pin mocks Date)',
			filename,
			code: `${vitest}it('a', () => { vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: false }); vi.setSystemTime(0); const start = Date.now(); expect(Date.now() - start).toBe(0); });\nit('b', () => { vi.useRealTimers(); vi.setSystemTime(0); const start = Date.now(); expect(Date.now() - start).toBe(0); });\nit('c', () => { vi.setSystemTime(0); const start = Date.now(); expect(Date.now() - start).toBe(0); vi.useFakeTimers(); });`,
		},
		{
			name: 'locals named like the stopwatch modules are not imports of them',
			filename,
			code: `${vitest}it('x', () => { const perf = { now: () => 1 }; const hooks = { performance: perf }; const hrtime = () => 2; perf.now(); hooks.performance.now(); hrtime(); globalThis.other.now(); });`,
		},
		{
			name: 'a shadowed Date, performance or process',
			filename,
			code: `${vitest}it('fakes', () => { const Date = { now: () => 1 }; const performance = { now: () => 2 }; const process = { hrtime: () => 3 }; const a = Date.now(); expect(Date.now() - a).toBe(0); performance.now(); process.hrtime(); });`,
		},
		{
			name: 'clock-shaped calls that are not clock reads',
			filename,
			code: `${vitest}it('x', () => { new Date(0).getTime() - new Date(1).getTime(); Date.parse('x') - Date.now(); new Date().toISOString(); clock.now() - clock.now(); Date.now(1) - Date.now(2); timer.hrtime.bigint(); process.hrtime.other(); new Foo().getTime() - Date.now(); now() - now(); new Date().toISOString() < Date.now(); });`,
		},
		{
			name: 'non-comparison operators and identifiers that never held a reading',
			filename,
			code: `${vitest}it('x', () => { const start = Date.now(); const later = start * 2; let other; other = 5; expect(Date.now() + start).toBeGreaterThan(0); expect(other < later).toBe(true); expect(undeclared < start).toBe(false); });`,
		},
	],
	invalid: [
		{
			name: 'a stopwatch around the code under test',
			filename,
			code: `${vitest}it('is fast', () => { const start = Date.now(); run(); expect(Date.now() - start).toBeLessThan(500); });`,
			errors: [{ message: elapsed }],
		},
		{
			name: 'two stored readings subtracted, including a reassigned one',
			filename,
			code: `${vitest}it('x', async () => { let stoppedAt: number | undefined; let abortedAt = 0; stoppedAt = Date.now(); abortedAt = new Date().getTime(); expect(abortedAt! - stoppedAt!).toBeLessThan(10); });`,
			errors: [{ message: elapsed }],
		},
		{
			name: 'a deadline loop and a busy spin',
			filename,
			code: `${vitest}function tick() { const until = Date.now() + 3; while (Date.now() < until) {} }\nit('x', async () => { const start = new Date().valueOf(); while (Date.now() === start) {} const deadline = Date.now() + 1000; if (Date.now() > deadline) throw new Error(); });`,
			errors: 3,
		},
		{
			name: 'performance.now and process.hrtime calls',
			filename,
			code: `${vitest}it('x', () => { const t0 = performance.now(); const h = process.hrtime(); const b = process.hrtime.bigint(); expect(performance.now() - t0).toBeLessThan(5); });`,
			errors: [
				{ message: stopwatch },
				{ message: stopwatch },
				{ message: stopwatch },
				{ message: stopwatch },
			],
		},
		{
			name: 'a pin in another test does not cover this one',
			filename,
			code: `${vitest}it('pinned', () => { vi.setSystemTime(0); });\nit('real', () => { const start = Date.now(); expect(Date.now() - start).toBe(0); });`,
			errors: 1,
		},
		{
			name: 'advancing fake timers alone does not fake Date',
			filename,
			code: `${vitest}it('x', () => { vi.useFakeTimers({ toFake: ['setTimeout'] }); const start = Date.now(); vi.runAllTimers(); expect(Date.now() - start).toBe(0); });`,
			errors: 1,
		},
		{
			name: 'a reading after the test switched back to real timers',
			filename,
			code: `${vitest}it('x', () => { vi.setSystemTime(0); vi.useRealTimers(); const start = Date.now(); expect(Date.now() - start).toBe(0); });`,
			errors: 1,
		},
		{
			name: 'stopwatches imported from node:perf_hooks and node:process, aliases included',
			filename,
			code: `${vitest}import { performance as perf } from 'node:perf_hooks';\nimport * as hooks from 'perf_hooks';\nimport { hrtime } from 'node:process';\nimport proc from 'process';\nit('x', () => { perf.now(); hooks.performance.now(); hrtime(); hrtime.bigint(); proc.hrtime(); proc.hrtime.bigint(); globalThis.performance.now(); });`,
			errors: 7,
		},
		{
			name: 'a pin that comes after the readings, or between them',
			filename,
			code: `${vitest}it('a', () => { const start = Date.now(); expect(Date.now() - start).toBe(0); vi.setSystemTime(0); });\nit('b', () => { const start = Date.now(); vi.setSystemTime(0); expect(Date.now() - start).toBe(0); });\nit('c', () => { vi.setSystemTime(Date.now() - 5 < Date.now() ? 0 : 1); });`,
			errors: 3,
		},
		{
			name: 'a pin that leaves Date real: toFake without Date, shouldAdvanceTime, an unreadable config',
			filename,
			code: `${vitest}it('a', () => { vi.useFakeTimers({ toFake: ['setTimeout'] }); vi.setSystemTime(0); const start = Date.now(); expect(Date.now() - start).toBe(0); });\nit('b', () => { vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(0); const start = Date.now(); expect(Date.now() - start).toBe(0); });\nit('c', () => { vi.useFakeTimers(config); vi.setSystemTime(0); const start = Date.now(); expect(Date.now() - start).toBe(0); });`,
			errors: 3,
		},
		{
			name: 'a pin in a nested function, or a reading in a callback the pin does not own',
			filename,
			code: `${vitest}it('a', () => { function later() { vi.setSystemTime(0); } const start = Date.now(); expect(Date.now() - start).toBe(0); });\nit('b', () => { vi.setSystemTime(0); const start = Date.now(); items.forEach(() => expect(Date.now() - start).toBe(0)); });`,
			errors: 2,
		},
		{
			name: 'a file under __tests__ that is not named .test',
			filename: 'src/__tests__/helpers/wait.ts',
			code: 'export function waitUntil(deadline: number) { return Date.now() >= deadline - 0 && Date.now() >= Date.now(); }',
			errors: 1,
		},
	],
});
