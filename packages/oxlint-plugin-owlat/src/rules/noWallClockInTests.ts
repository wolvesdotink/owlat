import { isGlobal, isTestFile, type Node, propertyName, unwrap, variableOf } from '../ast.ts';
import { fakeClock } from '../fakeClock.ts';
import type { AstNode, Context, Rule } from '../types.ts';

type CallExpression = Extract<AstNode, { type: 'CallExpression' }>;

/**
 * A test never measures elapsed wall-clock time. A stopwatch around the code
 * under test (`expect(Date.now() - start).toBeLessThan(500)`), a deadline loop
 * (`while (Date.now() < deadline)`) or a busy spin until the clock moves all
 * pass or fail with how loaded the machine is. Assert on events and
 * deterministic counters instead, or pin the clock with vitest's fake timers.
 *
 * Reported in test files (`*.test.*`, `*.spec.*`, anything under `__tests__/`):
 *
 * - every `performance.now()` and `process.hrtime()` call: they exist only to
 *   time the machine;
 * - a subtraction or comparison between two wall-clock readings, where a
 *   reading is `Date.now()` / `new Date().getTime()` (optionally plus or minus
 *   an offset, as deadlines are built) or a variable assigned one.
 *
 * A single reading is fine: fixture timestamps such as `createdAt: Date.now()`
 * or `Date.now() - DAY_MS` compare nothing with the clock. Readings in a
 * function that pins vitest's fake clock with `vi.setSystemTime` are
 * deterministic and allowed.
 */

const ELAPSED_MESSAGE =
	'Elapsed wall-clock time in a test: comparing two clock readings passes or fails with machine load. Assert on the events or counts the code produces, or pin the clock with vi.useFakeTimers and vi.setSystemTime.';
const STOPWATCH_MESSAGE =
	'Stopwatch in a test: performance.now() and process.hrtime() time the machine, not the code. Assert on events or deterministic counters instead.';

const COMPARISONS = new Set(['-', '<', '<=', '>', '>=', '===', '!==', '==', '!=']);
const OFFSETS = new Set(['+', '-']);
const DATE = new Set(['Date']);
const PERFORMANCE = new Set(['performance']);
const PROCESS = new Set(['process']);

/** `Date.now()`, `new Date().getTime()` or `new Date().valueOf()`. */
const isDateCall = (context: Context, node: Node): boolean => {
	const call = unwrap(node);
	if (call?.type !== 'CallExpression' || call.arguments.length > 0) return false;
	const callee = unwrap(call.callee);
	const name = propertyName(callee);
	if (callee?.type !== 'MemberExpression') return false;
	if (name === 'now') return isGlobal(context, callee.object, DATE);
	if (name !== 'getTime' && name !== 'valueOf') return false;
	const object = unwrap(callee.object);
	return (
		object?.type === 'NewExpression' &&
		object.arguments.length === 0 &&
		isGlobal(context, object.callee, DATE)
	);
};

/** `performance.now()`, `process.hrtime()` or `process.hrtime.bigint()`. */
const isStopwatchCall = (context: Context, node: CallExpression): boolean => {
	const callee = unwrap(node.callee);
	const name = propertyName(callee);
	if (callee?.type !== 'MemberExpression') return false;
	if (name === 'now') return isGlobal(context, callee.object, PERFORMANCE);
	if (name === 'hrtime') return isGlobal(context, callee.object, PROCESS);
	const inner = unwrap(callee.object);
	return (
		name === 'bigint' &&
		propertyName(inner) === 'hrtime' &&
		inner?.type === 'MemberExpression' &&
		isGlobal(context, inner.object, PROCESS)
	);
};

/** A clock reading taken here: `Date.now()`, or `Date.now() ± offset`. */
const isStamp = (context: Context, node: Node): boolean => {
	const value = unwrap(node);
	if (value?.type === 'BinaryExpression' && OFFSETS.has(value.operator)) {
		return isDateCall(context, value.left);
	}
	return isDateCall(context, value);
};

/** A clock reading: a stamp, or a variable some assignment stores a stamp in. */
const isReading = (context: Context, node: Node): boolean => {
	const value = unwrap(node);
	if (value?.type !== 'Identifier') return isStamp(context, value);
	const variable = variableOf(context, value);
	return (
		variable?.references.some(
			(reference) => reference.writeExpr !== null && isStamp(context, reference.writeExpr)
		) ?? false
	);
};

const rule: Rule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Disallow elapsed wall-clock measurements in tests (stopwatches, deadlines, clock spins).',
		},
	},
	create(context) {
		if (!isTestFile(context.filename)) return {};
		const { text } = context.sourceCode;
		const stopwatches = text.includes('performance') || text.includes('hrtime');
		const dates = text.includes('Date');
		if (!stopwatches && !dates) return {};
		const clock = fakeClock(context);
		const elapsed: AstNode[] = [];
		return {
			MemberExpression: clock.MemberExpression,
			CallExpression(node) {
				if (stopwatches && isStopwatchCall(context, node)) {
					context.report({ node, message: STOPWATCH_MESSAGE });
				}
			},
			BinaryExpression(node) {
				if (!dates || !COMPARISONS.has(node.operator)) return;
				if (isReading(context, node.left) && isReading(context, node.right)) elapsed.push(node);
			},
			'Program:exit'() {
				for (const node of elapsed) {
					if (!clock.drives(node, 'clock')) {
						context.report({ node, message: ELAPSED_MESSAGE });
					}
				}
			},
		};
	},
};

export default rule;
