import { isGlobal, isTestFile, type Node, propertyName, unwrap } from '../ast.ts';
import type { AstNode, Context, Rule } from '../types.ts';

type CallExpression = Extract<AstNode, { type: 'CallExpression' }>;

/**
 * Exponential backoff is computed in one place, `nextDelay` in
 * `@owlat/shared/retryPolicy`, from a policy its owner declares once. A wait
 * re-derived inline (`base * 2 ** (attempts - 1)`) restates the numbers and
 * picks its own indexing, and a wait kept in state and doubled
 * (`delay = Math.min(delay * 2, cap)`) hides the curve in the control flow.
 *
 * Reported outside test files and the policy module itself:
 *
 * - an exponentiation that grows, `a ** n` or `Math.pow(a, n)`: `a` is a
 *   numeric literal above 1 (10 excepted: powers of ten scale decimals) or a
 *   name that reads as a growth factor (`factor`, `multiplier`, `backoff`), and
 *   `n` is neither a constant nor negated (a negative exponent is a decay, such
 *   as a half-life);
 * - a wait multiplied in place by a constant above 1: `x = Math.min(x * k, cap)`
 *   (either argument order, either operand order) or `x *= k`, where `x` names
 *   a wait (`delay`, `backoff`, `retry`, `wait`, `interval`, or ends in `Ms`).
 */

const MESSAGE =
	'Inline exponential backoff: declare a RetryPolicy and compute the wait with nextDelay from @owlat/shared/retryPolicy.';

const POLICY_MODULE = /(?:^|[\\/])packages[\\/]shared[\\/]src[\\/]retryPolicy\.ts$/u;
const GROWTH_NAME = /factor|multiplier|backoff/iu;
const WAIT_NAME = /delay|backoff|retry|wait|interval/iu;
const MATH = new Set(['Math']);

/** A number literal, possibly signed. */
const numberValue = (node: Node): number | undefined => {
	const value = unwrap(node);
	if (value?.type === 'Literal' && typeof value.value === 'number') return value.value;
	if (value?.type === 'UnaryExpression' && (value.operator === '-' || value.operator === '+')) {
		const inner = numberValue(value.argument);
		if (inner === undefined) return undefined;
		return value.operator === '-' ? -inner : inner;
	}
	return undefined;
};

/** The name an identifier or a member access reads (`factor`, `policy.factor`). */
const nameOf = (node: Node): string | undefined => {
	const value = unwrap(node);
	if (value?.type === 'Identifier') return value.name;
	return propertyName(value);
};

const isGrowthBase = (node: Node): boolean => {
	const literal = numberValue(node);
	if (literal !== undefined) return literal > 1 && literal !== 10;
	const name = nameOf(node);
	return name !== undefined && GROWTH_NAME.test(name);
};

/** `-x`, or a product or quotient whose leftmost term is `-x`. */
const isNegated = (node: Node): boolean => {
	let value = unwrap(node);
	while (value?.type === 'BinaryExpression' && (value.operator === '*' || value.operator === '/')) {
		value = unwrap(value.left);
	}
	return value?.type === 'UnaryExpression' && value.operator === '-';
};

const isGrowingPower = (base: Node, exponent: Node): boolean =>
	isGrowthBase(base) && numberValue(exponent) === undefined && !isNegated(exponent);

/** `Math.<method>(…)` on the global `Math`. */
const isMathCall = (context: Context, node: Node, method: string): node is CallExpression => {
	const call = unwrap(node);
	if (call?.type !== 'CallExpression') return false;
	const callee = unwrap(call.callee);
	return (
		callee?.type === 'MemberExpression' &&
		propertyName(callee) === method &&
		isGlobal(context, callee.object, MATH)
	);
};

/** `target * k` or `k * target` with a constant `k` above 1. */
const scalesTarget = (context: Context, target: AstNode, operand: Node): boolean => {
	const product = unwrap(operand);
	if (product?.type !== 'BinaryExpression' || product.operator !== '*') return false;
	const [scaled, by] =
		numberValue(product.right) !== undefined
			? [product.left, product.right]
			: [product.right, product.left];
	const factor = numberValue(by);
	if (factor === undefined || factor <= 1) return false;
	const { sourceCode } = context;
	return sourceCode.getText(unwrap(scaled) as AstNode) === sourceCode.getText(target);
};

const rule: Rule = {
	meta: {
		type: 'suggestion',
		docs: {
			description:
				'Compute exponential backoff with nextDelay from @owlat/shared/retryPolicy, not inline.',
		},
	},
	create(context) {
		const { filename } = context;
		if (isTestFile(filename) || POLICY_MODULE.test(filename)) return {};
		const { text } = context.sourceCode;
		if (!text.includes('**') && !text.includes('Math.') && !text.includes('*=')) return {};
		return {
			BinaryExpression(node) {
				if (node.operator === '**' && isGrowingPower(node.left, node.right)) {
					context.report({ node, message: MESSAGE });
				}
			},
			CallExpression(node) {
				if (!isMathCall(context, node, 'pow')) return;
				const [base, exponent] = node.arguments;
				if (isGrowingPower(base, exponent)) context.report({ node, message: MESSAGE });
			},
			AssignmentExpression(node) {
				const name = nameOf(node.left);
				if (name === undefined || !(WAIT_NAME.test(name) || name.endsWith('Ms'))) return;
				if (node.operator === '*=') {
					const factor = numberValue(node.right);
					if (factor !== undefined && factor > 1) context.report({ node, message: MESSAGE });
					return;
				}
				if (node.operator !== '=' || !isMathCall(context, node.right, 'min')) return;
				const call = unwrap(node.right) as CallExpression;
				if (call.arguments.some((argument) => scalesTarget(context, node.left, argument))) {
					context.report({ node, message: MESSAGE });
				}
			},
		};
	},
};

export default rule;
