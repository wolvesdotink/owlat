import { isTestFile, type Node, someDescendant, unwrap } from '../ast.ts';
import type { AstNode, Context, Rule } from '../types.ts';
import { waitOf } from '../waits.ts';

/**
 * A test never polls: a loop that awaits a sleep or a tick until some
 * condition holds (`while (!done) await sleep(10)`, `for (…) { if (ready())
 * break; await flush(); }`) depends on how fast the machine gets there. Await
 * the event, promise or drained queue that makes the condition true instead.
 *
 * Reported in test files (`*.test.*`, `*.spec.*`, anything under `__tests__/`):
 * a `for` / `while` / `do…while` loop whose body awaits a wait (see waits.ts:
 * timer promises, `node:timers/promises`, `sleep` / `delay`, `Promise.resolve()`,
 * `flushPromises`, `nextTick`, or a local helper that wraps one) and that a
 * predicate keeps going: a conditional `break` / `return` / `throw` in the
 * body, or a loop condition other than `true` or a counter the loop moves by a
 * fixed, nonzero step (`i++`, `i -= 2`) and writes no other way. A fixed
 * number of flushes (`for (let i = 0; i < 3; i++) await flush()`) is not a
 * poll, and neither is a loop that awaits real work.
 */

const MESSAGE =
	'Polling loop in a test: it spins on a sleep or tick until a condition holds, so it passes or fails with machine speed. Await the event, promise or drained queue that makes the condition true.';

const COUNTER_OPERATORS = new Set(['<', '<=', '>', '>=']);

type Loop = Extract<AstNode, { type: 'ForStatement' | 'WhileStatement' | 'DoWhileStatement' }>;

const isExit = (node: AstNode) =>
	node.type === 'ReturnStatement' ||
	node.type === 'BreakStatement' ||
	node.type === 'ThrowStatement';

/** An `if` in the body that leaves the loop. */
const hasConditionalExit = (context: Context, body: Node): boolean => {
	const keys = context.sourceCode.visitorKeys;
	return someDescendant(
		keys,
		body,
		(node) =>
			node.type === 'IfStatement' &&
			(someDescendant(keys, node.consequent, isExit) ||
				someDescendant(keys, node.alternate, isExit))
	);
};

const ARITHMETIC = new Set(['+', '-', '*', '/', '%', '**']);

/** A bound fixed before the loop starts: numbers, names and arithmetic on them (`MAX * 3`). */
const isNumericBound = (node: Node): boolean => {
	const value = unwrap(node);
	if (value?.type === 'BinaryExpression' && ARITHMETIC.has(value.operator)) {
		return isNumericBound(value.left) && isNumericBound(value.right);
	}
	return (
		value?.type === 'Identifier' ||
		value?.type === 'MemberExpression' ||
		(value?.type === 'Literal' && typeof value.value === 'number')
	);
};

/** A nonzero number literal, optionally signed: a step that is the same every time. */
const isFixedStep = (node: Node): boolean => {
	const value = unwrap(node);
	if (value?.type === 'UnaryExpression' && (value.operator === '-' || value.operator === '+')) {
		return isFixedStep(value.argument);
	}
	return value?.type === 'Literal' && typeof value.value === 'number' && value.value !== 0;
};

const names = (node: Node, name: string): boolean => {
	const target = unwrap(node);
	return target?.type === 'Identifier' && target.name === name;
};

type Step = 'fixed' | 'other';

/** How a node writes the counter `name`: a fixed step (`i++`, `i += 2`), any other write, or not at all. */
const stepOf = (node: AstNode, name: string): Step | undefined => {
	if (node.type === 'UpdateExpression') return names(node.argument, name) ? 'fixed' : undefined;
	if (node.type !== 'AssignmentExpression' || !names(node.left, name)) return undefined;
	const fixed = (node.operator === '+=' || node.operator === '-=') && isFixedStep(node.right);
	return fixed ? 'fixed' : 'other';
};

/** Whether the loop's body or update writes `name` the given way. */
const writes = (context: Context, loop: Loop, name: string, step: Step): boolean =>
	[loop.body, loop.type === 'ForStatement' ? loop.update : null].some((node) =>
		someDescendant(context.sourceCode.visitorKeys, node, (child) => stepOf(child, name) === step)
	);

/**
 * `i < 3`, `attempt <= max` or `i++ < 3`, with a counter only the loop's
 * fixed step moves: a bound on the iterations, not a predicate about the
 * system.
 */
const isCounterTest = (context: Context, loop: Loop): boolean => {
	const test = unwrap(loop.test);
	if (test?.type !== 'BinaryExpression' || !COUNTER_OPERATORS.has(test.operator)) return false;
	return [
		[test.left, test.right],
		[test.right, test.left],
	].some(([side, bound]) => {
		if (!isNumericBound(bound)) return false;
		const counter = unwrap(side);
		// `i++ < 3` steps in the test itself; a bare `i` needs a step in the loop.
		const stepsInTest = counter?.type === 'UpdateExpression';
		const target = stepsInTest ? unwrap(counter.argument) : counter;
		if (target?.type !== 'Identifier') return false;
		if (writes(context, loop, target.name, 'other')) return false;
		return stepsInTest || writes(context, loop, target.name, 'fixed');
	});
};

const isTrue = (node: Node): boolean => {
	const value = unwrap(node);
	return value?.type === 'Literal' && value.value === true;
};

/** A predicate decides whether the loop keeps going. */
const isPredicateLoop = (context: Context, loop: Loop): boolean =>
	hasConditionalExit(context, loop.body) ||
	(loop.test !== null && !isTrue(loop.test) && !isCounterTest(context, loop));

const rule: Rule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Disallow loops in tests that await a sleep or tick until a condition holds; await the milestone instead.',
		},
	},
	create(context) {
		if (!isTestFile(context.filename) || !context.sourceCode.text.includes('await')) return {};
		const awaitsWait = (node: AstNode) =>
			node.type === 'AwaitExpression' && waitOf(context, unwrap(node.argument)) !== undefined;
		const check = (loop: Loop) => {
			if (!someDescendant(context.sourceCode.visitorKeys, loop.body, awaitsWait)) return;
			if (isPredicateLoop(context, loop)) context.report({ node: loop, message: MESSAGE });
		};
		return { ForStatement: check, WhileStatement: check, DoWhileStatement: check };
	},
};

export default rule;
