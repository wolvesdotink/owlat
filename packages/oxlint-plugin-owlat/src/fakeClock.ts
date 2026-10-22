/**
 * Whether vitest's fake timers drive a piece of test code. A timer promise that
 * the same test advances with `vi.advanceTimersByTimeAsync` (or runs with
 * `vi.runAllTimers`) resolves on fake time, and a `Date.now()` difference
 * after `vi.setSystemTime` is fixed; neither depends on the machine. Advancing
 * timers alone says nothing about `Date`: `useFakeTimers({ toFake })` can fake
 * the timers and leave the clock real, so only a pinned system time counts for
 * clock readings.
 *
 * The evidence has to sit in the function that owns the code (the test body or
 * helper around it, looking through `new Promise` executors), not anywhere in
 * the file: a file that fakes timers in one test can still sleep for real in
 * another. Within that function, `vi.useFakeTimers()` / `vi.useRealTimers()`
 * calls decide whether the fake clock is on where the code runs: a sleep before
 * the test switches fake timers on, or after it switches them off, is real.
 */
import { contains, enclosingFunction, propertyName, viMethod } from './ast.ts';
import type { AstNode, Context } from './types.ts';
import { isPromiseExecutor } from './waits.ts';

const DRIVERS = new Set([
	'advanceTimersByTime',
	'advanceTimersByTimeAsync',
	'advanceTimersToNextTimer',
	'advanceTimersToNextTimerAsync',
	'advanceTimersToNextFrame',
	'runAllTimers',
	'runAllTimersAsync',
	'runOnlyPendingTimers',
	'runOnlyPendingTimersAsync',
	'runAllTicks',
]);
const PIN = 'setSystemTime';
const TOGGLES = new Set(['useFakeTimers', 'useRealTimers']);

export interface FakeClock {
	/** Visitor for every `MemberExpression`; records `vi.*` timer calls and references. */
	MemberExpression(node: AstNode): void;
	/**
	 * Whether fake time drives `node`: its owner advances fake timers (`timers`)
	 * or pins the system time (`clock`), with fake timers on where `node` runs.
	 * Answer only from `Program:exit`, once the whole file has been visited.
	 */
	drives(node: AstNode, what: 'timers' | 'clock'): boolean;
}

export const fakeClock = (context: Context): FakeClock => {
	const advances: AstNode[] = [];
	const pins: AstNode[] = [];
	/** `vi.useFakeTimers` / `vi.useRealTimers` calls, in source order. */
	const toggles: AstNode[] = [];

	/** The test body or helper `node` runs in, looking through promise executors. */
	const owner = (node: AstNode): AstNode => {
		let fn = enclosingFunction(node);
		while (fn.type !== 'Program' && isPromiseExecutor(context, fn)) fn = enclosingFunction(fn);
		return fn;
	};

	return {
		MemberExpression(node) {
			const name = propertyName(node);
			if (name === undefined || (!DRIVERS.has(name) && name !== PIN && !TOGGLES.has(name))) {
				return;
			}
			if (viMethod(context, node) !== name) return;
			if (TOGGLES.has(name)) toggles.push(node);
			else if (name === PIN) pins.push(node);
			else advances.push(node);
		},
		drives(node, what) {
			const scope = owner(node);
			// At module level only module-level evidence counts; a test's own
			// fake clock says nothing about code outside every test.
			const covers = (mark: AstNode) =>
				contains(scope, mark) && (scope.type !== 'Program' || owner(mark) === scope);
			const evidence = what === 'timers' ? advances : pins;
			if (!evidence.some(covers)) return false;
			// The owner's own switches decide whether fake timers are on at `node`:
			// the last one before it, or else the state the first one after it
			// leaves (a test that ends with useRealTimers ran on fake timers).
			const own = toggles.filter(covers);
			const before = own.findLast((toggle) => toggle.start < node.start);
			if (before) return propertyName(before) === 'useFakeTimers';
			const after = own.find((toggle) => toggle.start > node.start);
			return after === undefined || propertyName(after) === 'useRealTimers';
		},
	};
};
