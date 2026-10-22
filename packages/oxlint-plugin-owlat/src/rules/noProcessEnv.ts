import { ALLOW_SCHEMA, allowed, inScope, SCOPE_SCHEMA, slashed } from '../lib/paths.ts';
import type { Allowance, ScopeOptions } from '../lib/paths.ts';
import { bindingOf, keyName, memberName, unwrap, type Node } from '../lib/ast.ts';
import type { AstNode, Context, Rule } from '../types.ts';

/**
 * Environment reads go through one module (the `allow` entry in oxlintrc.json,
 * `convex/lib/env.ts` for the Convex backend), whose accessors take a key from
 * the `EnvKey` union. Every access form is the same read, so the rule reports
 * the environment object itself rather than any one syntax:
 * `process.env.FOO`, `process.env['FOO']`, `process.env?.FOO`, `process['env']`,
 * `globalThis.process.env`, `const { env } = process`, `import { env } from
 * 'node:process'` and `Object.entries(process.env)` alike. The bracket and
 * destructuring forms are the shapes a key computed at runtime takes, the case
 * the union exists to prevent.
 *
 * `process` counts when it is the global or an import of `process` /
 * `node:process`; a local binding that shadows it is not the environment.
 */

interface Options extends ScopeOptions {
	allow?: Allowance[];
}

const PROCESS_MODULES = new Set(['process', 'node:process']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'self', 'window']);

/** `true` when `node` evaluates to the `process` object. */
const isProcess = (context: Context, node: Node): boolean => {
	const current = unwrap(node);
	if (current?.type === 'Identifier') {
		const binding = bindingOf(context, current);
		if (binding.type === 'global') return current.name === 'process';
		return (
			binding.type === 'import' &&
			PROCESS_MODULES.has(binding.source) &&
			(binding.imported === 'default' || binding.imported === '*')
		);
	}
	if (current?.type === 'MemberExpression' && memberName(current) === 'process') {
		const object = unwrap(current.object as AstNode);
		return (
			object?.type === 'Identifier' &&
			GLOBAL_OBJECTS.has(object.name) &&
			bindingOf(context, object).type === 'global'
		);
	}
	return false;
};

const MESSAGE =
	'Read the environment through the env module (getRequired / getOptional / getWithDefault from convex/lib/env.ts) and add new keys to its EnvKey union. Every access form of process.env bypasses that union.';

const rule: Rule = {
	meta: {
		type: 'problem',
		docs: { description: 'Read environment variables only through the env module.' },
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
		if (!context.sourceCode.text.includes('env')) return {};
		return {
			MemberExpression(node) {
				if (memberName(node) === 'env' && isProcess(context, node.object as AstNode)) {
					context.report({ node, message: MESSAGE });
				}
			},
			VariableDeclarator(node) {
				if (node.id.type !== 'ObjectPattern' || !isProcess(context, node.init as AstNode)) return;
				for (const property of node.id.properties) {
					if (keyName(property as AstNode) === 'env') {
						context.report({ node: property as AstNode, message: MESSAGE });
					}
				}
			},
			ImportSpecifier(node) {
				const { parent } = node;
				const imported =
					node.imported.type === 'Identifier' ? node.imported.name : String(node.imported.value);
				if (
					imported === 'env' &&
					parent?.type === 'ImportDeclaration' &&
					PROCESS_MODULES.has(String(parent.source.value))
				) {
					context.report({ node, message: MESSAGE });
				}
			},
		};
	},
};

export default rule;
