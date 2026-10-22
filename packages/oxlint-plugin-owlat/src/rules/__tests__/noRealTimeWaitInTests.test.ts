import rule from '../noRealTimeWaitInTests.ts';
import { ruleTester } from '../../__tests__/ruleTester.ts';

const filename = 'cases.test.ts';
const vitest = "import { it, vi } from 'vitest';\n";
const message = /^Real-clock wait in a test/;

ruleTester.run('owlat/no-real-time-wait-in-tests', rule, {
	valid: [
		{
			name: 'a sleep outside test files',
			filename: 'src/poller.ts',
			code: 'export const pause = () => new Promise((resolve) => setTimeout(resolve, 50));',
		},
		{
			name: 'a test file that names no timer at all',
			filename,
			code: `${vitest}it('adds', () => { expect(1 + 1).toBe(2); });`,
		},
		{
			name: 'awaiting the event that marks the milestone',
			filename,
			code: `${vitest}it('closes', async () => { await new Promise((resolve) => server.once('close', resolve)); });`,
		},
		{
			name: 'a zero-delay timer only yields a tick',
			filename,
			code: `${vitest}it('flushes', async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((r) => setTimeout(r)); });`,
		},
		{
			name: 'tick-only executors and immediates',
			filename,
			code: `${vitest}it('flushes', async () => { await new Promise(setImmediate); await new Promise((r) => process.nextTick(r)); await new Promise((r) => queueMicrotask(r)); });`,
		},
		{
			name: 'a timer started from a nested callback waits on something else first',
			filename,
			code: `${vitest}it('drains', async () => { await new Promise((r) => socket.once('drain', () => setTimeout(r, 10))); });`,
		},
		{
			name: 'a timer that schedules work rather than resolving a wait',
			filename,
			code: `${vitest}it('emits', () => { setTimeout(() => emitter.emit('tick'), 10); });`,
		},
		{
			name: 'a promise with no executor, or one that is not a function',
			filename,
			code: `${vitest}declare const run: (r: () => void) => void;\nit('x', async () => { new Promise(); await new Promise(run); });`,
		},
		{
			name: 'a local Promise class that shadows the global',
			filename,
			code: `${vitest}class Promise { constructor(fn: unknown) {} }\nit('x', () => { new Promise((r: () => void) => setTimeout(r, 10)); });`,
		},
		{
			name: 'a local setTimeout that shadows the global',
			filename,
			code: `${vitest}const setTimeout = (fn: () => void, ms: number) => fn();\nit('x', async () => { await new Promise<void>((r) => setTimeout(r, 10)); });`,
		},
		{
			name: 'a sleep the same test drives with fake timers',
			filename,
			code: `${vitest}it('fires', async () => { vi.useFakeTimers(); const done = new Promise((r) => setTimeout(r, 1000)); await vi.advanceTimersByTimeAsync(1000); await done; });`,
		},
		{
			name: 'a local sleep helper called in a test that runs all timers, with fake timers from beforeEach',
			filename,
			code: `${vitest}const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));\nbeforeEach(() => { vi.useFakeTimers(); });\nit('fires', async () => { const done = sleep(50); vi.runAllTimers(); await done; vi.useRealTimers(); });`,
		},
		{
			name: 'a toFake list that names the timer',
			filename,
			code: `${vitest}it('a', async () => { vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] }); const p = new Promise((r) => setTimeout(r, 10)); vi.runAllTimers(); await p; });`,
		},
		{
			name: 'fake timers passed to a hook uncalled',
			filename,
			code: `${vitest}beforeEach(vi.useFakeTimers);\nit('b', async () => { const p = new Promise((r) => setInterval(r, 10)); vi.runOnlyPendingTimers(); await p; });`,
		},
		{
			name: 'a config without toFake fakes the default timers',
			filename,
			code: `${vitest}it('x', async () => { vi.useFakeTimers({ now: 0, 'shouldAdvanceTime': false }); const p = new Promise((r) => setTimeout(r, 10)); vi.runAllTimers(); await p; });`,
		},
		{
			name: 'a timer driven from inside the executor of the promise it resolves',
			filename,
			code: `${vitest}it('x', async () => { vi.useFakeTimers(); await new Promise((r) => { setTimeout(r, 10); vi.advanceTimersByTime(10); }); });`,
		},
		{
			name: 'a test that passes vi.runAllTimers along drives fake timers too',
			filename,
			code: `${vitest}it('runs', async () => { const p = new Promise((r) => setTimeout(r, 10)); await t.finishAllScheduledFunctions(vi.runAllTimers); await p; });`,
		},
		{
			name: 'an aliased vi and a namespace vitest import',
			filename,
			code: "import { it, vi as fake } from 'vitest';\nimport * as vitest from 'vitest';\nit('a', async () => { const p = new Promise((r) => setTimeout(r, 10)); fake.advanceTimersByTime(10); await p; });\nit('b', async () => { const p = new Promise((r) => setTimeout(r, 10)); vitest.vi.runOnlyPendingTimers(); await p; });",
		},
		{
			name: 'a fake clock switched back on before the sleep',
			filename,
			code: `${vitest}it('x', async () => { vi.useRealTimers(); vi.useFakeTimers(); const p = new Promise((r) => setTimeout(r, 10)); vi.runAllTimers(); await p; });`,
		},
		{
			name: 'a sleep helper definition (its calls are reported instead)',
			filename,
			code: 'const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));\nfunction delay(ms: number) { return new Promise<void>(function (resolve) { setTimeout(resolve, ms); }); }\nconst helpers = { sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); } };',
		},
		{
			name: 'a zero sleep and timers/promises ticks',
			filename,
			code: "import { setImmediate as immediate, setTimeout as wait, scheduler } from 'node:timers/promises';\nawait sleep(0); await wait(); await wait(0); await immediate(); await scheduler.yield();",
		},
		{
			name: 'a timers/promises export that is not a timer, and a member of an unrelated import',
			filename,
			code: "import { promises } from 'node:timers';\nimport { scheduler } from 'node:timers/promises';\nimport * as other from './other';\nscheduler.unknown(); other.setTimeout(10); promises.unknown(10);",
		},
		{
			name: 'locals named like the timer modules are not imports of them',
			filename,
			code: 'const timers = { setTimeout: (fn: () => void, ms: number) => fn() };\nconst promises = { setTimeout: async (ms: number) => ms };\nawait new Promise<void>((r) => timers.setTimeout(r, 10)); await promises.setTimeout(10);',
		},
		{
			name: 'a computed member the rule cannot name, and a call of a call',
			filename,
			code: "declare const api: Record<string, (ms: number) => Promise<void>>;\nconst key = 'sleep';\nawait api[key](10); await make()(10);",
		},
		{
			name: 'a global setTimeout reached through an unknown object is not a global timer',
			filename,
			code: 'await new Promise((r) => clock.setTimeout(r, 10)); await new Promise((r) => process.other(r));',
		},
	],
	invalid: [
		{
			name: 'a timer promise with a delay',
			filename,
			code: `${vitest}it('waits', async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });`,
			errors: [{ message }],
		},
		{
			name: 'an interval in an executor, and globalThis.setTimeout with a computed delay',
			filename,
			code: `${vitest}it('polls', async () => { await new Promise<void>((r) => { const id = setInterval(() => r(), 10); }); await new Promise((r) => globalThis.setTimeout(r, delay * 2)); });`,
			errors: 2,
		},
		{
			name: 'a sleep timer wins over a tick in the same executor',
			filename,
			code: 'await new Promise((r) => { setImmediate(() => {}); setTimeout(r, 20); });',
			errors: [{ message }],
		},
		{
			name: 'a race timeout is a real-clock wait too',
			filename,
			code: "await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))]);",
			errors: 1,
		},
		{
			name: 'timers/promises in every import form',
			filename,
			code: "import { setTimeout as wait, setInterval, scheduler } from 'node:timers/promises';\nimport * as timers from 'timers/promises';\nimport timersDefault from 'node:timers/promises';\nawait wait(10); for await (const _ of setInterval(10)) break; await scheduler.wait(10); await timers.setTimeout(10); await timersDefault.setTimeout(5); await timers.scheduler.wait(5);",
			errors: 6,
		},
		{
			name: 'node:timers imports in every form, aliases included',
			filename,
			code: "import { setTimeout as later, promises } from 'node:timers';\nimport timers from 'timers';\nimport * as t from 'node:timers';\nawait new Promise((r) => later(r, 10)); await new Promise((r) => timers.setTimeout(r, 10)); await new Promise((r) => t.setInterval(r, 10)); await promises.setTimeout(10); await t.promises.setTimeout(10); await promises.scheduler.wait(10); await t.promises.scheduler.wait(10);",
			errors: 7,
		},
		{
			name: 'a timers/promises export imported by its string name',
			filename,
			code: "import { 'setTimeout' as wait } from 'node:timers/promises';\nawait wait(10);",
			errors: 1,
		},
		{
			name: 'helpers named sleep and delay, Bun.sleep and Playwright waitForTimeout',
			filename: 'e2e/flow.spec.ts',
			code: "import { sleep } from '../utils/sleep';\nawait sleep(100); await delay(); await Bun.sleep(5); await page.waitForTimeout(500);",
			errors: 4,
		},
		{
			name: 'a call to a locally defined sleep helper, not its definition',
			filename,
			code: 'const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));\nawait sleep(20);',
			errors: [{ message }],
		},
		{
			name: 'a waiting helper with another name is reported in its body',
			filename,
			code: 'async function settle() { await new Promise((r) => setTimeout(r, 20)); }\nawait settle();',
			errors: 1,
		},
		{
			name: 'a file under __tests__ that is not named .test',
			filename: 'src/__tests__/helpers/harness.ts',
			code: 'export const pause = () => new Promise((resolve) => setTimeout(resolve, 50));',
			errors: 1,
		},
		{
			name: 'fake timers driven in a different test do not cover this one',
			filename,
			code: `${vitest}it('fake', () => { vi.advanceTimersByTime(10); });\nit('real', async () => { await new Promise((r) => setTimeout(r, 10)); });`,
			errors: 1,
		},
		{
			name: 'a sleep before the test switches fake timers on',
			filename,
			code: `${vitest}it('x', async () => { await new Promise((r) => setTimeout(r, 10)); vi.useFakeTimers(); vi.runAllTimers(); });`,
			errors: 1,
		},
		{
			name: 'a sleep after the test switches back to real timers',
			filename,
			code: `${vitest}it('x', async () => { vi.runAllTimers(); vi.useRealTimers(); await new Promise((r) => setTimeout(r, 10)); });`,
			errors: 1,
		},
		{
			name: 'module-level evidence covers only module-level code',
			filename,
			code: `${vitest}vi.runAllTimers();\nit('x', async () => { await new Promise((r) => setTimeout(r, 10)); });`,
			errors: 1,
		},
		{
			name: 'a module-level sleep next to a timer drive inside a test',
			filename,
			code: `${vitest}await new Promise((r) => setTimeout(r, 10));\nit('x', () => { vi.runAllTimers(); });`,
			errors: 1,
		},
		{
			name: 'fake timers switched on and advanced only in a nested function',
			filename,
			code: `${vitest}it('x', async () => { function unused() { vi.useFakeTimers(); vi.runAllTimers(); } await new Promise((r) => setTimeout(r, 10)); });`,
			errors: 1,
		},
		{
			name: 'advancing fake timers that do not fake the timer the sleep uses',
			filename,
			code: `${vitest}it('a', async () => { vi.useFakeTimers({ toFake: ['Date'] }); const p = new Promise((r) => setTimeout(r, 10)); vi.runAllTimers(); await p; });\nit('b', async () => { vi.useFakeTimers({ toFake: ['setTimeout'] }); const p = new Promise((r) => setInterval(r, 10)); vi.runAllTimers(); await p; });`,
			errors: 2,
		},
		{
			name: 'a hook whose fake timers leave the timer real',
			filename,
			code: `${vitest}beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setInterval'] }); });\nit('x', async () => { const p = new Promise((r) => setTimeout(r, 10)); vi.runAllTimers(); await p; });`,
			errors: 1,
		},
		{
			name: 'fake timer configs the rule cannot read',
			filename,
			code: `${vitest}it('a', async () => { vi.useFakeTimers(config); const p = new Promise((r) => setTimeout(r, 10)); vi.runAllTimers(); await p; });\nit('b', async () => { vi.useFakeTimers({ ...base }); const p = new Promise((r) => setTimeout(r, 10)); vi.runAllTimers(); await p; });\nit('c', async () => { vi.useFakeTimers({ toFake: list }); const p = new Promise((r) => setTimeout(r, 10)); vi.runAllTimers(); await p; });\nit('d', async () => { vi.useFakeTimers({ toFake: ['setTimeout', ...more] }); const p = new Promise((r) => setTimeout(r, 10)); vi.runAllTimers(); await p; });\nit('e', async () => { vi.useFakeTimers({ [key]: [] }); const p = new Promise((r) => setTimeout(r, 10)); vi.runAllTimers(); await p; });`,
			errors: 5,
		},
		{
			name: 'waits fake timers never drive: imported helpers, timer modules, Bun and Playwright',
			filename,
			code: `${vitest}import { sleep } from './sleep';\nimport { setTimeout as wait } from 'node:timers/promises';\nimport { setTimeout as later } from 'node:timers';\nit('x', async () => { vi.useFakeTimers(); const a = sleep(10); const b = wait(10); const c = new Promise((r) => later(r, 10)); const d = Bun.sleep(10); const e = page.waitForTimeout(10); await vi.runAllTimersAsync(); await Promise.all([a, b, c, d, e]); });`,
			errors: 5,
		},
		{
			name: 'a vi that is not vitest does not drive anything',
			filename,
			code: "import { vi } from './not-vitest';\nimport * as vitest from 'vitest';\nit('x', async () => { vi.runAllTimers(); vitest.other.runAllTimers(); const p = new Promise((r) => setTimeout(r, 10)); await p; });",
			errors: 1,
		},
	],
});
