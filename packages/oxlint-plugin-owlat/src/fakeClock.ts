/**
 * Whether vitest's fake timers drive a piece of test code. A timer promise that
 * the same test advances with `vi.advanceTimersByTimeAsync` (or runs with
 * `vi.runAllTimers`) resolves on fake time, and `Date.now()` readings taken
 * after `vi.setSystemTime` are fixed; neither depends on the machine.
 *
 * Only what is actually faked counts. `vi.useFakeTimers({ toFake })` replaces
 * the listed globals and leaves the rest real, so advancing timers says nothing
 * about a `setTimeout` it does not list, and a pin says nothing about `Date`
 * when `Date` is not listed (or `shouldAdvanceTime` lets it follow the real
 * clock). A config the rules cannot read is taken to fake nothing.
 *
 * The evidence has to sit in the function that owns the code (the test body or
 * helper around it, looking through `new Promise` executors), not anywhere in
 * the file and not in a nested function, which may never run: a file that
 * fakes timers in one test can still sleep for real in another. Within that
 * function, `vi.useFakeTimers()` / `vi.useRealTimers()` calls decide whether
 * the fake clock is on where the code runs: a sleep before the test switches
 * fake timers on, or after it switches them off, is real. With no switch of its
 * own before the code, a function runs under whatever its hooks set up, so
 * every `vi.useFakeTimers` config elsewhere in the file has to fake the API.
 */
import { enclosingFunction, type Node, propertyName, unwrap, viMethod } from './ast.ts';
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
/** What vitest leaves real when `toFake` is not given. */
const NOT_FAKED_BY_DEFAULT = new Set(['nextTick', 'queueMicrotask']);

type Faked = (api: string) => boolean;

const byDefault: Faked = (api) => !NOT_FAKED_BY_DEFAULT.has(api);
const nothing: Faked = () => false;

interface Mark {
	/** The `vi.*` call, or the member itself when it is passed along uncalled. */
	node: AstNode;
	owner: AstNode;
}

interface State {
	/** Fake timers are installed. */
	on: boolean;
	faked: Faked;
}

interface Toggle extends Mark, State {}

const REAL: State = { on: false, faked: nothing };

/** The call a `vi.*` member is the callee of, or the member itself. */
const callOf = (member: AstNode): AstNode => {
	const parent = member.parent;
	return parent?.type === 'CallExpression' && parent.callee === member ? parent : member;
};

const keyName = (property: AstNode): string | undefined => {
	if (property.type !== 'Property' || property.computed) return undefined;
	const { key } = property;
	if (key.type === 'Identifier') return key.name;
	return key.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined;
};

/** The string literals of an array literal, or undefined if it holds anything else. */
const stringList = (node: Node): Set<string> | undefined => {
	const value = unwrap(node);
	if (value?.type !== 'ArrayExpression') return undefined;
	const names = new Set<string>();
	for (const element of value.elements) {
		const item = unwrap(element);
		if (item?.type !== 'Literal' || typeof item.value !== 'string') return undefined;
		names.add(item.value);
	}
	return names;
};

/**
 * What a `vi.useFakeTimers(config)` call fakes: its literal `toFake` list or
 * vitest's default, minus `Date` under `shouldAdvanceTime` (the fake clock then
 * follows the real one). A non-literal config fakes nothing as far as the
 * rules can tell. An uncalled reference (`beforeEach(vi.useFakeTimers)`) uses
 * the default.
 */
const fakedBy = (call: AstNode): Faked => {
	if (call.type !== 'CallExpression') return byDefault;
	const config = unwrap(call.arguments[0]);
	if (config === undefined || config === null) return byDefault;
	if (config.type !== 'ObjectExpression') return nothing;
	let faked = byDefault;
	let followsRealClock = false;
	for (const property of config.properties) {
		const name = keyName(property);
		if (name === undefined || property.type !== 'Property') return nothing;
		if (name === 'toFake') {
			const list = stringList(property.value);
			if (!list) return nothing;
			faked = (api) => list.has(api);
		}
		if (name === 'shouldAdvanceTime') {
			const value = unwrap(property.value);
			followsRealClock = !(value?.type === 'Literal' && value.value === false);
		}
	}
	return followsRealClock ? (api) => api !== 'Date' && faked(api) : faked;
};

export interface FakeClock {
	/** Visitor for every `MemberExpression`; records `vi.*` timer calls and references. */
	MemberExpression(node: AstNode): void;
	/**
	 * Whether fake time drives the sleep at `node`, started through the global
	 * `timer`: its owner advances fake timers, and fake timers that replace
	 * `timer` are on where `node` runs.
	 * Answer only from `Program:exit`, once the whole file has been visited.
	 */
	drivesTimer(node: AstNode, timer: string): boolean;
	/**
	 * Whether the clock reading at `node` is pinned: its owner called
	 * `vi.setSystemTime` before it, with `Date` faked at that point, and has not
	 * switched timers since. Answer only from `Program:exit`.
	 */
	pinned(node: AstNode): boolean;
}

export const fakeClock = (context: Context): FakeClock => {
	const advances: Mark[] = [];
	const pins: Mark[] = [];
	/** `vi.useFakeTimers` / `vi.useRealTimers` calls, in source order. */
	const toggles: Toggle[] = [];

	/** The test body or helper `node` runs in, looking through promise executors. */
	const owner = (node: AstNode): AstNode => {
		let fn = enclosingFunction(node);
		while (fn.type !== 'Program' && isPromiseExecutor(context, fn)) fn = enclosingFunction(fn);
		return fn;
	};

	/** Whether fake timers are on just before `position` in `scope`, and what they fake. */
	const stateAt = (scope: AstNode, position: number): State => {
		const own = toggles.filter((toggle) => toggle.owner === scope);
		const before = own.findLast((toggle) => toggle.node.end <= position);
		if (before) return before;
		if (own.find((toggle) => toggle.node.start >= position)?.on) return REAL;
		const elsewhere = toggles.filter((toggle) => toggle.on);
		return { on: true, faked: (api) => elsewhere.every((toggle) => toggle.faked(api)) };
	};

	return {
		MemberExpression(node) {
			const name = propertyName(node);
			if (name === undefined || (!DRIVERS.has(name) && name !== PIN && !TOGGLES.has(name))) {
				return;
			}
			if (viMethod(context, node) !== name) return;
			const call = callOf(node);
			const mark = { node: call, owner: owner(call) };
			if (name === 'useFakeTimers') toggles.push({ ...mark, on: true, faked: fakedBy(call) });
			else if (name === 'useRealTimers') toggles.push({ ...mark, ...REAL });
			else if (name === PIN) pins.push(mark);
			else advances.push(mark);
		},
		drivesTimer(node, timer) {
			const scope = owner(node);
			if (!advances.some((advance) => advance.owner === scope)) return false;
			const state = stateAt(scope, node.start);
			return state.on && state.faked(timer);
		},
		pinned(node) {
			const scope = owner(node);
			return pins.some((pin) => {
				if (pin.owner !== scope || pin.node.end > node.start) return false;
				const switched = toggles.some(
					(toggle) =>
						toggle.owner === scope &&
						toggle.node.start >= pin.node.end &&
						toggle.node.end <= node.start
				);
				if (switched) return false;
				// With fake timers off, setSystemTime mocks Date by itself.
				const state = stateAt(scope, pin.node.start);
				return !state.on || state.faked('Date');
			});
		},
	};
};
