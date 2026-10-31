import { inScope, SCOPE_SCHEMA, slashed } from '../lib/paths.ts';
import type { ScopeOptions } from '../lib/paths.ts';
import { optedOut, resolvedName, walk } from '../lib/ast.ts';
import { builderTableFor, registeredFunctions } from '../lib/convexBuilders.ts';
import type { BuilderFloor, BuilderKind } from '../lib/convexBuilders.ts';
import type { AstNode, Rule } from '../types.ts';

/**
 * The org-scoped builders resolve the caller's membership session in their
 * auth floor and thread it to the handler as its third argument
 * (`handler: async (ctx, args, session) => …`). A handler that calls a
 * session-resolving helper (the `helpers` option: getMutationContext,
 * requireOrgPermission, …) resolves the same session a second time: an extra
 * database round trip per call and a second, drift-prone copy of the auth
 * decision. Role checks belong on the threaded session:
 * `requirePermission(hasPermission(session.role, '<scope>:<verb>'))`.
 *
 * The functions checked are those registered with a builder whose kind and
 * floor the options select (queries and mutations with a member or role
 * floor; an action cannot read the database, so it threads no session).
 * Functions on other builders (internal, public, identity, actions) are never
 * entered: resolving a session by hand is correct there. One finding per
 * function, on its exported name. A handler that must resolve its own session
 * says why: `// session: <reason>` inside the definition or in the comment
 * lines directly above it.
 */

interface Options extends ScopeOptions {
	helpers?: string[];
	kinds?: BuilderKind[];
	floors?: BuilderFloor[];
}

const rule: Rule = {
	meta: {
		type: 'suggestion',
		docs: {
			description:
				'Use the session the builder threads to the handler instead of resolving it again.',
		},
		schema: [
			{
				type: 'object',
				properties: {
					...SCOPE_SCHEMA,
					helpers: { type: 'array', items: { type: 'string' } },
					kinds: { type: 'array', items: { enum: ['query', 'mutation', 'action'] } },
					floors: {
						type: 'array',
						items: { enum: ['member', 'role', 'identity', 'public', 'raw'] },
					},
				},
				required: ['helpers', 'kinds', 'floors'],
				additionalProperties: false,
			},
		],
	},
	create(context) {
		const options = context.options[0] as Options | undefined;
		if (!options || !inScope(slashed(context.filename), options)) return {};
		const helpers = new Set(options.helpers);
		const { text } = context.sourceCode;
		if (![...helpers].some((helper) => text.includes(helper))) return {};
		const kinds = new Set(options.kinds);
		const floors = new Set(options.floors);

		return {
			Program(program) {
				const table = builderTableFor(context);
				if (!table) return;
				for (const definition of registeredFunctions(context, table, program as AstNode)) {
					const { builder } = definition;
					if (!kinds.has(builder.kind) || !floors.has(builder.floor)) continue;
					let helper: string | undefined;
					walk(context, definition.call, (node) => {
						if (helper !== undefined) return false;
						if (node.type !== 'CallExpression') return;
						// Resolved by binding: an aliased import or a namespace member
						// (`sessions.getMutationContext`) is the helper; a method of the same
						// name on some other object (`x.requireOrgMember()`) resolves to nothing.
						const name = resolvedName(context, node.callee as AstNode);
						if (name !== undefined && helpers.has(name)) helper = name;
					});
					if (helper === undefined || optedOut(context, definition.statement, 'session')) continue;
					context.report({
						node: definition.nameNode,
						message: `\`${definition.name}\` (${builder.name}) calls ${helper}(), resolving the session its builder already resolved and threads to the handler. Take it as the handler's third argument (\`handler: async (ctx, args, session) => …\`) and gate roles with requirePermission(hasPermission(session.role, '<scope>:<verb>')). A handler that must resolve its own session says why: \`// session: <reason>\`.`,
					});
				}
			},
		};
	},
};

export default rule;
