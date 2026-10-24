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
 * `globalThis.process.env`, `const { env } = process`, `({ env } = process)`,
 * `function f({ env } = process)`, `const { process: { env } } = globalThis`,
 * `import { env } from 'node:process'` and `Object.entries(process.env)` alike.
 * A rest element (`const { ...rest } = process`) holds `env` too. The bracket
 * and destructuring forms are the shapes a key computed at runtime takes, the
 * case the union exists to prevent.
 *
 * `process` counts when it is the global or an import of `process` /
 * `node:process`; a local binding that shadows it is not the environment.
 */

interface Options extends ScopeOptions {
	allow?: Allowance[];
}

const PROCESS_MODULES = new Set(['process', 'node:process']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'self', 'window']);

/** `true` when `node` is the global object that `process` hangs off. */
const isGlobalObject = (context: Context, node: Node): boolean => {
	const current = unwrap(node);
	return (
		current?.type === 'Identifier' &&
		GLOBAL_OBJECTS.has(current.name) &&
		bindingOf(context, current).type === 'global'
	);
};

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
	return (
		current?.type === 'MemberExpression' &&
		memberName(current) === 'process' &&
		isGlobalObject(context, current.object as AstNode)
	);
};

type ObjectPattern = Extract<AstNode, { type: 'ObjectPattern' }>;

/** The object pattern a destructuring target is, past a default (`{ … } = fallback`). */
const objectPattern = (node: Node): ObjectPattern | undefined => {
	const current = node?.type === 'AssignmentPattern' ? (node.left as Node) : node;
	return current?.type === 'ObjectPattern' ? current : undefined;
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
		// Every form the rule recognises names `process` (the global, the module or
		// the member); `env` need not appear (`const { ...rest } = process`).
		if (!context.sourceCode.text.includes('process')) return {};
		// A nested target can be reached twice: in
		// `const { process: { env } = process } = globalThis` it is both a
		// `process` key of the global object and a default of `process`.
		const reported = new Set<AstNode>();
		const report = (node: AstNode) => {
			if (reported.has(node)) return;
			reported.add(node);
			context.report({ node, message: MESSAGE });
		};
		/** A pattern bound to `process`: its `env` key, or a rest element that copies it. */
		const reportEnvKeys = (pattern: ObjectPattern) => {
			for (const property of pattern.properties) {
				if (property.type === 'RestElement' || keyName(property as AstNode) === 'env') {
					report(property as AstNode);
				}
			}
		};
		/**
		 * Every form that destructures a value has a target and a source: a
		 * declaration, an assignment, and a parameter or property default. A
		 * `process` key is followed when the source is the global object.
		 */
		const destructured = (target: Node, source: Node) => {
			const pattern = objectPattern(target);
			if (!pattern) return;
			if (isProcess(context, source)) {
				reportEnvKeys(pattern);
				return;
			}
			if (!isGlobalObject(context, source)) return;
			for (const property of pattern.properties) {
				if (property.type === 'Property' && keyName(property as AstNode) === 'process') {
					const inner = objectPattern(property.value as AstNode);
					if (inner) reportEnvKeys(inner);
				}
			}
		};
		return {
			MemberExpression(node) {
				if (memberName(node) === 'env' && isProcess(context, node.object as AstNode)) {
					report(node);
				}
			},
			VariableDeclarator(node) {
				destructured(node.id as AstNode, node.init as AstNode);
			},
			AssignmentExpression(node) {
				if (node.operator === '=') destructured(node.left as AstNode, node.right as AstNode);
			},
			AssignmentPattern(node) {
				destructured(node.left as AstNode, node.right as AstNode);
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
