import { isGlobal, isTestFile, type Node, propertyName, variableOf } from '../ast.ts';
import type { AstNode, Context, Rule } from '../types.ts';

/**
 * Parsed JSON is untrusted until something has checked it. A type argument on
 * a JSON read or a cast of its result tells the compiler a shape nobody
 * verified: `await c.req.json<SendBody>()` accepts `"recipients": 42` and hands
 * it to the business code, where it surfaces as a TypeError or as a value
 * stored under the wrong type. The read decodes to `unknown` and a decoder
 * narrows it: `decodeJson` / `decodeJsonText` / `decodeJsonValue` from
 * `@owlat/worker-protocol/decodeJson`, or a type guard the module owns.
 *
 * A JSON source is a zero-argument `.json()` call (a fetch `Request` or
 * `Response`, Hono's `c.req.json()`), `JSON.parse(…)` on the global `JSON`, or
 * h3's `readBody(…)`, seen through parentheses, `await`, `!`, a `.catch(…)`
 * fallback and an intermediate `as unknown`. Reported outside tests:
 *
 * - a type argument on the read itself: `req.json<T>()`, `readBody<T>(event)`;
 * - a source cast to anything but `unknown`: `(await res.json()) as T`,
 *   `JSON.parse(text) as T`, `JSON.parse(text) as unknown as T`, `<T>JSON.parse(text)`;
 * - a source assigned to a binding annotated with anything but `unknown`:
 *   `const body: T = await req.json()`, or `body = JSON.parse(text)` where
 *   `body` was declared `let body: T`.
 *
 * Not enforced anywhere: an untyped binding (`const body = JSON.parse(text)`).
 * It takes the explicit `any` that `JSON.parse` and `.json()` are declared to
 * return, so strict mode (`noImplicitAny` included) accepts `body.to.trim()`
 * without a check, and this rule, which looks for casts, does not see it
 * either. Reviewers have to catch that case.
 */

const MESSAGE =
	'Unchecked JSON: a type argument or cast is not a check. Parse to `unknown` and narrow it with a decoder (decodeJson / decodeJsonText / decodeJsonValue from @owlat/worker-protocol/decodeJson) or a type guard.';

const JSON_GLOBAL = new Set(['JSON']);
const H3_BODY_READERS = new Set(['readBody']);

type CallExpression = Extract<AstNode, { type: 'CallExpression' }>;

/** A type node that is the `unknown` keyword. */
const isUnknownType = (node: Node): boolean => node?.type === 'TSUnknownKeyword';

/** The annotation a binding identifier or a type-annotated pattern carries, if any. */
const annotationOf = (node: Node): Node => {
	if (!node || !('typeAnnotation' in node)) return undefined;
	const annotation = node.typeAnnotation as Node;
	return annotation?.type === 'TSTypeAnnotation' ? (annotation.typeAnnotation as Node) : undefined;
};

/** `x.json()` with no arguments: a body read, not Hono's `c.json(value)` response builder. */
const isJsonRead = (call: CallExpression): boolean =>
	call.callee.type === 'MemberExpression' &&
	propertyName(call.callee) === 'json' &&
	call.arguments.length === 0;

const isJsonParse = (context: Context, call: CallExpression): boolean =>
	call.callee.type === 'MemberExpression' &&
	propertyName(call.callee) === 'parse' &&
	isGlobal(context, call.callee.object, JSON_GLOBAL);

/** h3's `readBody`, auto-imported in Nitro (a global here) or imported by name. */
const isH3BodyRead = (context: Context, call: CallExpression): boolean => {
	const { callee } = call;
	if (callee.type !== 'Identifier' || !H3_BODY_READERS.has(callee.name)) return false;
	const definition = variableOf(context, callee)?.defs[0];
	return definition === undefined || definition.type === 'ImportBinding';
};

/** The JSON-reading call `node` evaluates to, seen through the wrappers that keep its value. */
const jsonSource = (context: Context, node: Node): CallExpression | undefined => {
	let current = node;
	for (;;) {
		if (!current) return undefined;
		if (current.type === 'AwaitExpression') {
			current = current.argument as Node;
			continue;
		}
		if (current.type === 'ParenthesizedExpression' || current.type === 'TSNonNullExpression') {
			current = current.expression as Node;
			continue;
		}
		// `x as unknown` is the honest form; only what is cast AFTER it matters.
		if (current.type === 'TSAsExpression' && isUnknownType(current.typeAnnotation as Node)) {
			current = current.expression as Node;
			continue;
		}
		if (current.type !== 'CallExpression') return undefined;
		// `req.json().catch(() => fallback)`: the value is still the read's.
		if (current.callee.type === 'MemberExpression' && propertyName(current.callee) === 'catch') {
			current = current.callee.object as Node;
			continue;
		}
		return isJsonRead(current) || isJsonParse(context, current) || isH3BodyRead(context, current)
			? current
			: undefined;
	}
};

/** A JSON source without its own type argument (that one is reported on the call). */
const untypedSource = (context: Context, node: Node): boolean => {
	const source = jsonSource(context, node);
	return source !== undefined && !('typeArguments' in source && source.typeArguments);
};

const rule: Rule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Decode parsed JSON to `unknown` and check it; never assert its type with a type argument or cast.',
		},
	},
	create(context) {
		if (isTestFile(context.filename)) return {};
		const { text } = context.sourceCode;
		if (!text.includes('json') && !text.includes('JSON') && !text.includes('readBody')) return {};
		const report = (node: AstNode) => context.report({ node, message: MESSAGE });
		return {
			CallExpression(node) {
				if (!('typeArguments' in node) || !node.typeArguments) return;
				if (isJsonRead(node) || isH3BodyRead(context, node)) report(node);
			},
			TSAsExpression(node) {
				if (isUnknownType(node.typeAnnotation as Node)) return;
				if (jsonSource(context, node.expression as Node)) report(node);
			},
			TSTypeAssertion(node) {
				if (isUnknownType(node.typeAnnotation as Node)) return;
				if (jsonSource(context, node.expression as Node)) report(node);
			},
			VariableDeclarator(node) {
				const annotation = annotationOf(node.id as Node);
				if (!annotation || isUnknownType(annotation)) return;
				if (untypedSource(context, node.init as Node)) report(node);
			},
			AssignmentExpression(node) {
				if (node.operator !== '=' || node.left.type !== 'Identifier') return;
				if (!untypedSource(context, node.right as Node)) return;
				const declared = variableOf(context, node.left)?.defs[0]?.name as Node;
				const annotation = annotationOf(declared);
				if (annotation && !isUnknownType(annotation)) report(node);
			},
		};
	},
};

export default rule;
