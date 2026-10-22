import { ALLOW_SCHEMA, allowed, inScope, SCOPE_SCHEMA, slashed } from '../lib/paths.ts';
import type { Allowance, ScopeOptions } from '../lib/paths.ts';
import { memberName, unwrap } from '../lib/ast.ts';
import { rawBuilderKind } from '../lib/convexBuilders.ts';
import type { AstNode, Rule } from '../types.ts';

/**
 * Convex publishes every non-internal function on the public client API, so a
 * function built with the bare `query` / `mutation` / `action` builder is an
 * unauthenticated endpoint unless its handler remembers to gate itself. Public
 * functions use the secure-by-default builders from convex/lib/authedFunctions.ts
 * (`authed*`, or an explicit `public*` with its `// public:` note), the one
 * module listed under `allow`.
 *
 * The raw builders are recognized by where they come from, not by their
 * spelling: `query` / `mutation` / `action` imported from a `_generated/server`
 * module (under any local name, or as a namespace member) and their
 * `queryGeneric` / `mutationGeneric` / `actionGeneric` originals from
 * `convex/server`. Every use is reported, a call, an alias (`const q = query`)
 * or a re-export alike; an import nothing uses is reported on the import.
 * `internal*` builders and `httpAction` are unaffected; `ctx.db.query(…)` is not
 * a builder.
 */

interface Options extends ScopeOptions {
	allow?: Allowance[];
}

const MESSAGE = (name: string) =>
	`\`${name}\` is a raw Convex builder: anything built with it is reachable by anonymous callers. Use the secure-by-default builders from convex/lib/authedFunctions.ts: authedQuery / authedMutation / authedAction (require auth), publicQuery / publicMutation / publicAction (intentional, with a '// public:' note), or internalQuery / internalMutation / internalAction (server-only).`;

const importedName = (node: AstNode): string =>
	node.type === 'Identifier' ? node.name : String((node as { value?: unknown }).value);

const rule: Rule = {
	meta: {
		type: 'problem',
		docs: {
			description: 'Ban the raw Convex query/mutation/action builders outside the wrapper module.',
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
		if (!text.includes('_generated/server') && !text.includes('convex/server')) return {};
		const { sourceCode } = context;

		return {
			ImportDeclaration(node) {
				const source = String(node.source.value);
				for (const specifier of node.specifiers) {
					let imported: string;
					if (specifier.type === 'ImportNamespaceSpecifier') imported = '*';
					else if (specifier.type === 'ImportSpecifier') {
						imported = importedName(specifier.imported as AstNode);
						if (!rawBuilderKind(source, imported)) continue;
					} else continue;
					const [variable] = sourceCode.getDeclaredVariables(specifier as AstNode);
					const references = variable?.references ?? [];
					if (imported === '*') {
						// `server.query(…)`: only the raw members of the namespace count.
						for (const { identifier } of references) {
							const member = identifier.parent;
							const name = memberName(member as AstNode);
							if (
								member?.type === 'MemberExpression' &&
								unwrap(member.object as AstNode) === identifier &&
								name !== undefined &&
								rawBuilderKind(source, name)
							) {
								context.report({ node: member, message: MESSAGE(name) });
							}
						}
						continue;
					}
					if (references.length === 0) {
						context.report({ node: specifier as AstNode, message: MESSAGE(imported) });
						continue;
					}
					for (const { identifier } of references) {
						context.report({ node: identifier as AstNode, message: MESSAGE(imported) });
					}
				}
			},
			ExportNamedDeclaration(node) {
				if (!node.source) return;
				const source = String(node.source.value);
				for (const specifier of node.specifiers) {
					const local = importedName(specifier.local as AstNode);
					if (rawBuilderKind(source, local)) {
						context.report({ node: specifier as AstNode, message: MESSAGE(local) });
					}
				}
			},
			ExportAllDeclaration(node) {
				const source = String(node.source.value);
				if (rawBuilderKind(source, 'query') || rawBuilderKind(source, 'queryGeneric')) {
					context.report({ node, message: MESSAGE('*') });
				}
			},
		};
	},
};

export default rule;
