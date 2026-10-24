import { ALLOW_SCHEMA, allowed, inScope, SCOPE_SCHEMA, slashed } from '../lib/paths.ts';
import type { Allowance, ScopeOptions } from '../lib/paths.ts';
import { bindingOf, keyName, memberName, staticString, unwrap } from '../lib/ast.ts';
import { isRawBuilderSource, rawBuilderKind } from '../lib/convexBuilders.ts';
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
 * module (under any local name, as a namespace member, or destructured from
 * the namespace) and their `queryGeneric` / `mutationGeneric` /
 * `actionGeneric` originals from `convex/server`. Every use is reported, a
 * call, an alias (`const q = query`) or a re-export alike; an import nothing
 * uses is reported on the import. A namespace import of either module may only
 * be read by static member name or destructured into static names: any other
 * use (aliasing it, passing it along, a computed member, a rest element) and a
 * dynamic `import()` / `require()` of it hide which builder ends up called,
 * so they are reported as well.
 * `internal*` builders and `httpAction` are unaffected; `ctx.db.query(…)` is not
 * a builder.
 */

interface Options extends ScopeOptions {
	allow?: Allowance[];
}

const MESSAGE = (name: string) =>
	`\`${name}\` is a raw Convex builder: anything built with it is reachable by anonymous callers. Use the secure-by-default builders from convex/lib/authedFunctions.ts: authedQuery / authedMutation / authedAction (require auth), publicQuery / publicMutation / publicAction (intentional, with a '// public:' note), or internalQuery / internalMutation / internalAction (server-only).`;

const ESCAPE =
	'This hands the Convex server module on where its raw query/mutation/action builders can no longer be traced. Import the builders you need by name: the secure-by-default ones from convex/lib/authedFunctions.ts, internal* / httpAction from _generated/server.';

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

		/** Raw or unverifiable keys of a pattern destructuring the server module. */
		const checkPattern = (source: string, pattern: AstNode) => {
			if (pattern.type !== 'ObjectPattern') {
				context.report({ node: pattern, message: ESCAPE });
				return;
			}
			for (const property of pattern.properties) {
				const name = property.type === 'Property' ? keyName(property) : undefined;
				if (name === undefined) context.report({ node: property, message: ESCAPE });
				else if (rawBuilderKind(source, name)) {
					context.report({ node: property, message: MESSAGE(name) });
				}
			}
		};

		/**
		 * One reference to a namespace import of a builder module. Reading a safe
		 * member by name (`server.internalQuery`) or destructuring safe names is
		 * fine; a raw member is reported; any other use (a computed member, a
		 * rest element, an alias, an argument, a re-export) hands the module on
		 * where its raw members can no longer be traced, and is reported too.
		 */
		const checkNamespaceUse = (source: string, identifier: AstNode) => {
			let outer = identifier;
			while (outer.parent && unwrap(outer.parent as AstNode) === identifier) {
				outer = outer.parent as AstNode;
			}
			const parent = outer.parent as AstNode | null;
			if (parent?.type === 'MemberExpression' && parent.object === outer) {
				const name = memberName(parent);
				if (name === undefined) context.report({ node: parent, message: ESCAPE });
				else if (rawBuilderKind(source, name))
					context.report({ node: parent, message: MESSAGE(name) });
				return;
			}
			if (parent?.type === 'VariableDeclarator' && parent.init === outer) {
				checkPattern(source, parent.id as AstNode);
				return;
			}
			if (parent?.type === 'AssignmentExpression' && parent.right === outer) {
				checkPattern(source, parent.left as AstNode);
				return;
			}
			// Type positions: `typeof server` names no value; `server.query` as a
			// qualified name does.
			if (parent?.type === 'TSTypeQuery') return;
			if (parent?.type === 'TSQualifiedName' && parent.left === outer) {
				const name = parent.right.type === 'Identifier' ? parent.right.name : undefined;
				if (name !== undefined && rawBuilderKind(source, name)) {
					context.report({ node: parent, message: MESSAGE(name) });
				}
				return;
			}
			context.report({ node: identifier, message: ESCAPE });
		};

		/** `import('…/_generated/server')` / `require(…)`: the module object, untraceable. */
		const checkDynamicLoad = (node: AstNode, specifier: AstNode | undefined) => {
			const source = staticString(specifier);
			if (source !== undefined && isRawBuilderSource(source)) {
				context.report({ node, message: ESCAPE });
			}
		};

		return {
			ImportExpression(node) {
				checkDynamicLoad(node, node.source as AstNode);
			},
			CallExpression(node) {
				const callee = unwrap(node.callee as AstNode);
				if (
					callee?.type === 'Identifier' &&
					callee.name === 'require' &&
					bindingOf(context, callee).type === 'global'
				) {
					checkDynamicLoad(node, node.arguments[0] as AstNode | undefined);
				}
			},
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
						if (isRawBuilderSource(source)) {
							for (const { identifier } of references) {
								checkNamespaceUse(source, identifier as AstNode);
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
