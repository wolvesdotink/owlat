import { ALLOW_SCHEMA, allowed, inScope, SCOPE_SCHEMA, slashed } from '../lib/paths.ts';
import type { Allowance, ScopeOptions } from '../lib/paths.ts';
import { calleeName, keyName, staticString, unwrap, walk, type Node } from '../lib/ast.ts';
import type { AstNode, Context, Rule } from '../types.ts';

/**
 * HMAC signing and constant-time comparison each have one home per runtime
 * (the modules listed under `allow` in oxlintrc.json, each with its reason),
 * so every compare and every HMAC behaves the same way. Outside those modules
 * the rule reports:
 *
 *   importKey(HMAC)               an `importKey(…)` call whose algorithm (third
 *                                 argument) is 'HMAC' or `{ name: 'HMAC' }`
 *   importKey(variable algorithm) an `importKey(…)` whose algorithm is not a
 *                                 literal, since it may be HMAC
 *   sign(HMAC), verify(HMAC)      a `sign`/`verify` whose algorithm is HMAC
 *   generateKey(HMAC), deriveKey(HMAC)
 *                                 an HMAC key generated or derived in place
 *   timingSafeEqual               any use of node:crypto's `timingSafeEqual`:
 *                                 a call, an import (aliased or not), a
 *                                 destructuring or a property access
 *   xor-compare                   a hand-written XOR-accumulate compare:
 *                                 `acc |= a ^ b`, `acc += a ^ b`,
 *                                 `acc = acc | (a ^ b)`, `acc = acc + (a ^ b)`,
 *                                 however the statement is wrapped
 *
 * The algorithm names are matched case-insensitively, as Web Crypto does.
 * Node's `createHmac` is not reported: several modules sign with it today, and
 * moving them is a separate decision from this boundary.
 */

interface Options extends ScopeOptions {
	allow?: Allowance[];
}

/** The algorithm name an argument spells, or `null` when it is not a literal. */
const algorithmName = (node: Node): string | null => {
	const literal = staticString(node);
	if (literal !== undefined) return literal;
	const current = unwrap(node);
	if (current?.type !== 'ObjectExpression') return null;
	for (const property of current.properties) {
		if (keyName(property as AstNode) === 'name' && property.type === 'Property') {
			return staticString(property.value as AstNode) ?? null;
		}
	}
	return null;
};

const isHmac = (node: Node): boolean => algorithmName(node)?.toUpperCase() === 'HMAC';

const XOR_ACCUMULATORS = new Set(['|=', '+=']);

const containsXor = (context: Context, node: Node): boolean => {
	let found = false;
	walk(
		context,
		node,
		(child) => {
			if (found) return false;
			if (child.type === 'BinaryExpression' && child.operator === '^') found = true;
			return !found;
		},
		{ skipFunctions: true }
	);
	return found;
};

/** The leftmost operand of a left-associated `a | b | c` / `a + b + c` chain. */
const leftmost = (node: Node, operator: string): Node => {
	let current = unwrap(node);
	while (current?.type === 'BinaryExpression' && current.operator === operator) {
		current = unwrap(current.left as AstNode);
	}
	return current;
};

const xorCompare = (context: Context, node: AstNode): boolean => {
	if (node.type !== 'AssignmentExpression') return false;
	if (XOR_ACCUMULATORS.has(node.operator)) return containsXor(context, node.right as AstNode);
	if (node.operator !== '=' || node.left.type !== 'Identifier') return false;
	const right = unwrap(node.right as AstNode);
	if (right?.type !== 'BinaryExpression' || (right.operator !== '|' && right.operator !== '+')) {
		return false;
	}
	const first = leftmost(right, right.operator);
	return (
		first?.type === 'Identifier' &&
		first.name === node.left.name &&
		containsXor(context, right as AstNode)
	);
};

const SAFE_EQUAL = 'timingSafeEqual';

const rule: Rule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Keep HMAC signing and constant-time comparison in their sanctioned modules (the shared helpers per runtime).',
		},
		schema: [
			{
				type: 'object',
				properties: { ...SCOPE_SCHEMA, allow: ALLOW_SCHEMA },
				additionalProperties: false,
			},
		],
	},
	create(context) {
		const options = context.options[0] as Options | undefined;
		const filename = slashed(context.filename);
		if (!inScope(filename, options) || allowed(filename, options?.allow)) return {};
		const { text } = context.sourceCode;
		if (!/importKey|sign|verify|generateKey|deriveKey|timingSafeEqual|\^/u.test(text)) return {};

		const reported = new Set<number>();
		const report = (node: AstNode, what: string) => {
			if (reported.has(node.start)) return;
			reported.add(node.start);
			context.report({
				node,
				message: `${what} outside the sanctioned crypto modules. Use the shared helper for the runtime: Convex \`constantTimeEqual\` / \`secretMatches\` / \`hmacSignature\` from convex/lib/crypto.ts, Node services \`@owlat/shared/constantTimeEqual\`, MTA -> API \`@owlat/mta-protocol/signer\`. A new home needs an \`allow\` entry with its reason in oxlintrc.json.`,
			});
		};

		return {
			CallExpression(node) {
				const name = calleeName(node.callee as AstNode);
				const callee = unwrap(node.callee as AstNode);
				const at = (callee?.type === 'MemberExpression' ? callee.property : callee) as AstNode;
				const args = node.arguments as AstNode[];
				if (name === 'importKey') {
					if (args.length < 3 || args.some((arg) => arg.type === 'SpreadElement')) return;
					const algorithm = algorithmName(args[2]);
					if (algorithm === null) report(at, 'importKey(variable algorithm)');
					else if (algorithm.toUpperCase() === 'HMAC') report(at, 'importKey(HMAC)');
				} else if (
					(name === 'sign' || name === 'verify' || name === 'generateKey') &&
					isHmac(args[0])
				) {
					report(at, `${name}(HMAC)`);
				} else if (name === 'deriveKey' && isHmac(args[2])) {
					report(at, 'deriveKey(HMAC)');
				}
			},
			Identifier(node) {
				if (node.name === SAFE_EQUAL) report(node, SAFE_EQUAL);
			},
			Literal(node) {
				// `crypto['timingSafeEqual']`, `{ 'timingSafeEqual': eq } = crypto`
				if (node.value !== SAFE_EQUAL) return;
				const { parent } = node;
				if (
					(parent?.type === 'MemberExpression' && parent.property === node) ||
					(parent?.type === 'Property' && parent.key === node)
				) {
					report(node, SAFE_EQUAL);
				}
			},
			AssignmentExpression(node) {
				if (xorCompare(context, node)) report(node, 'xor-compare');
			},
		};
	},
};

export default rule;
