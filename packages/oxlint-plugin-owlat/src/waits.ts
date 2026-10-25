/**
 * What counts as a wait in test code, shared by the real-time-wait and
 * polling-loop rules so the two never disagree about a sleep.
 *
 * A `sleep` lasts real time: a timer with a delay that is not a literal 0, a
 * `node:timers/promises` timer, a helper named `sleep` / `delay`, Bun's
 * `sleep`, Playwright's `waitForTimeout`. A `tick` only yields to the event
 * loop: a zero-delay timer, `setImmediate`, `process.nextTick`,
 * `queueMicrotask`, `Promise.resolve()`, Vue's `nextTick` and test-utils'
 * `flushPromises`. Timers count only when they resolve a `new Promise` from its
 * executor; a timer that schedules other work is not a wait. The `node:timers`,
 * `node:timers/promises` and `node:process` exports count like the globals.
 */
import {
	builtinExport,
	enclosingFunction,
	FUNCTIONS,
	functionBody,
	importOf,
	isGlobal,
	isProcess,
	type Node,
	PROCESS_MODULES,
	propertyName,
	someDescendant,
	unwrap,
	variableOf,
} from './ast.ts';
import { importedSleepTimer } from './importedSleep.ts';
import type { AstNode, Context } from './types.ts';

export type WaitKind = 'sleep' | 'tick';

export interface Wait {
	kind: WaitKind;
	/** Where a report points: the timer or sleep call, or the promise itself. */
	node: AstNode;
	/** The call reaches the wait through a local helper, whose body holds the wait itself. */
	viaHelper: boolean;
	/**
	 * The global timer behind a sleep (`setTimeout`, `setInterval`), which
	 * vitest's fake timers can replace. Undefined when nothing fake can drive
	 * the wait: a `node:timers` or `node:timers/promises` import (vitest swaps
	 * the globals only), Bun's `sleep`, Playwright's `waitForTimeout`, or a
	 * `sleep` helper whose body neither this file nor a relative import it
	 * names shows (see importedSleep.ts).
	 */
	timer?: string;
}

const TIMERS = new Set(['timers', 'node:timers']);
const TIMERS_PROMISES = new Set(['timers/promises', 'node:timers/promises']);
const DELAY_TIMERS = new Set(['setTimeout', 'setInterval']);
const CALLBACK_TIMERS = new Set([...DELAY_TIMERS, 'setImmediate', 'queueMicrotask']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window']);
const PROMISE = new Set(['Promise']);
/** Helper names that mean a real-time sleep whatever they are bound to. */
export const SLEEP_HELPERS = new Set(['sleep', 'delay']);
const SLEEP_METHODS = new Set(['sleep', 'sleepSync', 'waitForTimeout']);
const TICK_IMPORTS = new Map([
	['flushPromises', '@vue/test-utils'],
	['nextTick', 'vue'],
]);

const isZero = (node: Node): boolean => {
	const value = unwrap(node);
	return value?.type === 'Literal' && value.value === 0;
};

/** A delay argument: a literal 0 yields a tick, anything else waits real time. */
const delayKind = (delay: Node, whenAbsent: WaitKind): WaitKind => {
	if (delay === undefined || delay === null) return whenAbsent;
	return isZero(delay) ? 'tick' : 'sleep';
};

const strongest = (current: Wait | undefined, next: Wait | undefined): Wait | undefined =>
	current?.kind === 'sleep' || next === undefined ? (current ?? next) : next;

interface Timer {
	name: string;
	/** A global vitest's fake timers replace, not a `node:timers` export. */
	global: boolean;
}

/**
 * The callback timer `node` names: `setTimeout`, `globalThis.setTimeout`,
 * `process.nextTick`, or one imported from `node:timers` / `node:process`.
 */
const callbackTimer = (context: Context, node: Node): Timer | undefined => {
	const target = unwrap(node);
	if (target?.type === 'Identifier' && isGlobal(context, target, CALLBACK_TIMERS)) {
		return { name: target.name, global: true };
	}
	const member = propertyName(target);
	if (member !== undefined && target?.type === 'MemberExpression') {
		if (CALLBACK_TIMERS.has(member) && isGlobal(context, target.object, GLOBAL_OBJECTS)) {
			return { name: member, global: true };
		}
		if (member === 'nextTick' && isProcess(context, target.object)) {
			return { name: member, global: false };
		}
	}
	const exported = builtinExport(context, target, TIMERS);
	if (exported !== undefined && CALLBACK_TIMERS.has(exported)) {
		return { name: exported, global: false };
	}
	if (builtinExport(context, target, PROCESS_MODULES) === 'nextTick') {
		return { name: 'nextTick', global: false };
	}
	return undefined;
};

/** Whether `fn` is the executor of a `new Promise(fn)`. */
export const isPromiseExecutor = (context: Context, fn: AstNode): boolean => {
	const parent = fn.parent;
	return (
		parent?.type === 'NewExpression' &&
		unwrap(parent.arguments[0]) === fn &&
		isGlobal(context, parent.callee, PROMISE)
	);
};

/**
 * The wait a `new Promise(executor)` is: an executor that is a timer itself
 * (`new Promise(setImmediate)`) ticks; otherwise the strongest timer the
 * executor starts directly, not from a nested callback (which waits on
 * something else first).
 */
export const promiseWait = (context: Context, node: Node): Wait | undefined => {
	if (node?.type !== 'NewExpression' || !isGlobal(context, node.callee, PROMISE)) return undefined;
	const executor = unwrap(node.arguments[0]);
	if (!executor) return undefined;
	if (callbackTimer(context, executor) !== undefined) {
		return { kind: 'tick', node, viaHelper: false };
	}
	const body = functionBody(executor);
	if (!body) return undefined;
	let found: Wait | undefined;
	someDescendant(context.sourceCode.visitorKeys, body, (child) => {
		if (child.type !== 'CallExpression') return false;
		const timer = callbackTimer(context, child.callee);
		if (timer === undefined) return false;
		const kind = DELAY_TIMERS.has(timer.name) ? delayKind(child.arguments[1], 'tick') : 'tick';
		found = strongest(found, {
			kind,
			node: child,
			viaHelper: false,
			timer: timer.global ? timer.name : undefined,
		});
		return kind === 'sleep';
	});
	return found;
};

/**
 * The `node:timers/promises` export a callee calls: `setTimeout`,
 * `scheduler.wait`, … The module is also `promises` on `node:timers`.
 */
const timersPromisesCall = (context: Context, callee: Node): string | undefined => {
	const exported = builtinExport(context, callee, TIMERS_PROMISES);
	if (exported !== undefined) return exported;
	const name = propertyName(callee);
	if (name === undefined || callee?.type !== 'MemberExpression') return undefined;
	const object = unwrap(callee.object);
	if (builtinExport(context, object, TIMERS) === 'promises') return name;
	if (builtinExport(context, object, TIMERS_PROMISES) === 'scheduler') return `scheduler.${name}`;
	const viaTimers =
		propertyName(object) === 'scheduler' &&
		object?.type === 'MemberExpression' &&
		builtinExport(context, unwrap(object.object), TIMERS) === 'promises';
	return viaTimers ? `scheduler.${name}` : undefined;
};

const timersPromisesKind = (exported: string, delay: Node): WaitKind | undefined => {
	if (DELAY_TIMERS.has(exported) || exported === 'scheduler.wait') {
		return delayKind(delay, 'tick');
	}
	if (exported === 'setImmediate' || exported === 'scheduler.yield') return 'tick';
	return undefined;
};

/** The function a local binding holds, if it is declared in this file as a function. */
const localFunction = (context: Context, identifier: Node): AstNode | undefined => {
	const definition = variableOf(context, identifier)?.defs[0];
	if (!definition) return undefined;
	if (definition.type === 'FunctionName' && FUNCTIONS.has(definition.node.type)) {
		return definition.node;
	}
	if (definition.type !== 'Variable' || definition.node.type !== 'VariableDeclarator') {
		return undefined;
	}
	const init = unwrap(definition.node.init);
	return init && FUNCTIONS.has(init.type) ? init : undefined;
};

/** The strongest wait anywhere in a helper's body, following further local helpers. */
const helperWait = (context: Context, fn: AstNode, seen: Set<AstNode>): Wait | undefined => {
	if (seen.has(fn)) return undefined;
	seen.add(fn);
	let found: Wait | undefined;
	someDescendant(context.sourceCode.visitorKeys, functionBody(fn), (child) => {
		found = strongest(found, waitOf(context, child, seen));
		return found?.kind === 'sleep';
	});
	return found;
};

/**
 * Whether the file names `timers` at all; the timer-module lookups are
 * skipped otherwise. Remembered for the file being linted, keyed by its text:
 * oxlint reuses its `sourceCode` object from file to file.
 */
let lastText: string | undefined;
let lastNamesTimers = false;
const namesTimers = (context: Context): boolean => {
	const { text } = context.sourceCode;
	if (text !== lastText) {
		lastText = text;
		lastNamesTimers = text.includes('timers');
	}
	return lastNamesTimers;
};

/**
 * The wait a call is, if it is one. With `sleepsOnly` only the calls that can
 * sleep by themselves are resolved (no ticks, no local helpers), which keeps
 * the per-call cost to a name check for a rule that reports sleeps alone.
 */
export const callWait = (
	context: Context,
	node: Node,
	options: { sleepsOnly?: boolean; seen?: Set<AstNode> } = {}
): Wait | undefined => {
	if (node?.type !== 'CallExpression') return undefined;
	const callee = unwrap(node.callee);
	const [first] = node.arguments;
	const direct = (kind: WaitKind | undefined): Wait | undefined =>
		kind === undefined ? undefined : { kind, node, viaHelper: false };

	if (namesTimers(context)) {
		const exported = timersPromisesCall(context, callee);
		if (exported !== undefined) return direct(timersPromisesKind(exported, first));
	}

	if (callee?.type === 'Identifier') {
		if (SLEEP_HELPERS.has(callee.name)) {
			// Fake timers drive the helper only through the global timer its body
			// starts: a local helper's body is read here, a relative import's by
			// importedSleep.ts, and any other import's is out of sight.
			const fn = localFunction(context, callee);
			const inner = fn && helperWait(context, fn, options.seen ?? new Set());
			const binding = fn ? undefined : importOf(context, callee);
			const timer =
				inner?.timer ??
				(binding && importedSleepTimer(context.filename, binding.source, binding.imported));
			return { kind: delayKind(first, 'sleep'), node, viaHelper: false, timer };
		}
		if (options.sleepsOnly) return undefined;
		const binding = importOf(context, callee);
		if (binding) {
			return direct(TICK_IMPORTS.get(binding.imported) === binding.source ? 'tick' : undefined);
		}
		const fn = localFunction(context, callee);
		const inner = fn && helperWait(context, fn, options.seen ?? new Set());
		return inner && { kind: inner.kind, node, viaHelper: true, timer: inner.timer };
	}

	const method = propertyName(callee);
	if (method === undefined || callee?.type !== 'MemberExpression') return undefined;
	if (SLEEP_METHODS.has(method)) return direct(delayKind(first, 'sleep'));
	if (options.sleepsOnly) return undefined;
	if (method === 'resolve' && isGlobal(context, callee.object, PROMISE)) return direct('tick');
	return undefined;
};

/** The wait an expression is: a timer promise or a waiting call. */
export const waitOf = (context: Context, node: Node, seen?: Set<AstNode>): Wait | undefined =>
	node?.type === 'NewExpression' ? promiseWait(context, node) : callWait(context, node, { seen });

/**
 * Whether `node` sits in the body of a helper named `sleep` / `delay`. Such a
 * helper is reported where it is called, once per wait, not where it is
 * defined.
 */
export const insideSleepHelper = (node: AstNode): boolean => {
	let fn = enclosingFunction(node);
	while (FUNCTIONS.has(fn.type)) {
		const parent = fn.parent;
		let name: string | undefined;
		if (fn.type === 'FunctionDeclaration' || fn.type === 'FunctionExpression') {
			name = fn.id?.name;
		}
		if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
			name = parent.id.name;
		}
		if (
			(parent?.type === 'MethodDefinition' || parent?.type === 'Property') &&
			parent.key.type === 'Identifier'
		) {
			name = parent.key.name;
		}
		if (name !== undefined) return SLEEP_HELPERS.has(name);
		// An anonymous executor or callback: the helper, if any, is further out.
		fn = enclosingFunction(fn);
	}
	return false;
};
