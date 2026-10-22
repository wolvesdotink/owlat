import { ALLOW_SCHEMA, allowed, inScope, SCOPE_SCHEMA, slashed } from '../lib/paths.ts';
import type { Allowance, ScopeOptions } from '../lib/paths.ts';
import { bindingOf, resolvedName, unwrap, within } from '../lib/ast.ts';
import { builderTableFor, registeredFunctions } from '../lib/convexBuilders.ts';
import type { AstNode, Rule } from '../types.ts';

/**
 * The Operation error taxonomy at the thrown seam of the Convex backend:
 *
 *  1. `ConvexError` is constructed (or subclassed) only in the module listed
 *     under `allow` (convex/_utils/errors.ts). Every user-facing failure goes
 *     through its `throw*` helpers, which emit the canonical
 *     `{ category, message, data? }` payload rather than a hand-rolled code.
 *     Catching it (`instanceof ConvexError`) is fine.
 *  2. No bare `throw new Error(…)` / `throw Error(…)` lexically inside a
 *     function registered with a public builder (every builder the derivation
 *     in apps/api/scripts/lib/convex-builders.sh lists, plus the raw Convex
 *     builders). Those failures reach the client and must carry a category.
 *     `internal*` functions and plain helpers may still throw a bare Error: an
 *     invariant bug, never surfaced. `httpAction` handlers serialize failures
 *     through lib/httpResponse.ts and are out of scope.
 *
 * Category-literal validity stays with the compiler: every category is typed
 * `OperationErrorCategory`, so tsc rejects an out-of-union value.
 */

interface Options extends ScopeOptions {
	/** Modules that may construct ConvexError. */
	allow?: Allowance[];
}

const CONVEX_ERROR = 'ConvexError';

const rule: Rule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Construct ConvexError only in the errors module and keep bare Error throws out of public Convex handlers.',
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
		if (!inScope(filename, options)) return {};
		const { text } = context.sourceCode;
		const checkConstruction = text.includes(CONVEX_ERROR) && !allowed(filename, options?.allow);
		const checkThrows = /\bthrow\b/u.test(text) && /\bError\b/u.test(text);
		if (!checkConstruction && !checkThrows) return {};

		const isConvexError = (node: AstNode) => resolvedName(context, node) === CONVEX_ERROR;
		const construction = (node: AstNode) =>
			context.report({
				node,
				message:
					'Throw through the coded helpers in convex/_utils/errors.ts (throwNotFound / throwForbidden / throwInvalidState / throwConflict / throwRateLimited / throwInternal / …) instead of constructing ConvexError here.',
			});

		const throws: AstNode[] = [];
		return {
			NewExpression(node) {
				if (checkConstruction && isConvexError(node.callee as AstNode)) construction(node);
			},
			ClassDeclaration(node) {
				if (checkConstruction && node.superClass && isConvexError(node.superClass as AstNode)) {
					construction(node.superClass as AstNode);
				}
			},
			ClassExpression(node) {
				if (checkConstruction && node.superClass && isConvexError(node.superClass as AstNode)) {
					construction(node.superClass as AstNode);
				}
			},
			ThrowStatement(node) {
				if (!checkThrows) return;
				const argument = unwrap(node.argument as AstNode);
				if (argument?.type !== 'NewExpression' && argument?.type !== 'CallExpression') return;
				const callee = unwrap(argument.callee as AstNode);
				if (callee?.type !== 'Identifier' || callee.name !== 'Error') return;
				if (bindingOf(context, callee).type !== 'global') return;
				throws.push(node);
			},
			'Program:exit'(program: AstNode) {
				if (throws.length === 0) return;
				const table = builderTableFor(context);
				if (!table) return;
				const definitions = registeredFunctions(context, table, program);
				for (const thrown of throws) {
					const definition = definitions.find(({ call }) => within(thrown, call));
					if (!definition) continue;
					context.report({
						node: thrown,
						message: `Bare Error thrown inside \`${definition.name}\` (${definition.builder.name}), a function the client calls. Surface the failure with a coded helper from convex/_utils/errors.ts so the frontend can categorize it; internal functions and helpers may keep a bare Error.`,
					});
				}
			},
		};
	},
};

export default rule;
