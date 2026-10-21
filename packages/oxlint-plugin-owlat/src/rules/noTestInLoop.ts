import type { AstNode, Context, Rule, Scope } from '../types.ts';

/**
 * Tests and suites are declared with `.each`, never inside a loop. A loop hides
 * the case list inside control flow and builds each title in the loop body,
 * where it drifts silently when the loop changes. `it.each(cases)(title, fn)`
 * keeps the cases as data under one title template, the form the rest of the
 * suites already use.
 *
 * Only calls that resolve to vitest's own `it` / `test` / `describe` / `suite`
 * import count (with their `.only` / `.skip` / `.concurrent` / … modifiers, the
 * curried `.each(…)(…)` / `.for(…)(…)` / `.skipIf(…)(…)` / `.extend(…)(…)`
 * forms and tagged-template `.each` tables, chained in any order), so an
 * unrelated function that happens to be called `test` is never flagged. A loop
 * inside a test body is fine: a function boundary between the call and the loop
 * ends the search.
 *
 * The rule runs on every linted file, so it does the cheap checks first: a file
 * that never names vitest is skipped, and a call is resolved against scope (the
 * expensive part) only once it is known to sit inside a loop.
 */

const TEST_FUNCTIONS = new Set(['it', 'test', 'describe', 'suite']);
const MODIFIERS = new Set(['only', 'skip', 'todo', 'concurrent', 'sequential', 'fails', 'shuffle']);
const CURRIED = new Set(['each', 'for', 'skipIf', 'runIf', 'extend']);
const LOOPS = new Set([
	'ForStatement',
	'ForInStatement',
	'ForOfStatement',
	'WhileStatement',
	'DoWhileStatement',
]);
const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration']);
const WRAPPERS = new Set([
	'ChainExpression',
	'ParenthesizedExpression',
	'TSNonNullExpression',
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSTypeAssertion',
]);

type Node = AstNode | null | undefined;

const unwrap = (node: Node): Node => {
	let current = node;
	while (current && WRAPPERS.has(current.type) && 'expression' in current) {
		current = current.expression as Node;
	}
	return current;
};

const propertyName = (node: Node): string | undefined => {
	if (node?.type !== 'MemberExpression') return undefined;
	const { property } = node;
	if (!node.computed && property.type === 'Identifier') return property.name;
	if (property.type === 'Literal' && typeof property.value === 'string') return property.value;
	return undefined;
};

/** The vitest export an identifier is bound to, or `namespace` for `import * as`. */
const vitestImport = (context: Context, identifier: Node): string | undefined => {
	if (identifier?.type !== 'Identifier') return undefined;
	let scope: Scope | null = context.sourceCode.getScope(identifier);
	while (scope) {
		const variable = scope.set.get(identifier.name);
		if (variable) {
			const definition = variable.defs[0];
			const declaration = definition?.parent;
			if (
				definition?.type !== 'ImportBinding' ||
				declaration?.type !== 'ImportDeclaration' ||
				declaration.source.value !== 'vitest'
			) {
				return undefined;
			}
			const specifier = definition.node;
			if (specifier.type === 'ImportNamespaceSpecifier') return 'namespace';
			if (specifier.type !== 'ImportSpecifier') return undefined;
			const { imported } = specifier;
			return imported.type === 'Identifier' ? imported.name : String(imported.value);
		}
		scope = scope.upper;
	}
	return undefined;
};

/**
 * The test function a declaration callee is built from, if it declares a test
 * or suite. The callee is peeled from the outside in: modifiers (`.only`,
 * `.skip.concurrent`), factory calls (`.each(cases)`, `.skipIf(cond)`,
 * `.extend(fixtures)`) and tagged-template tables (`.each`/`.for` with a
 * template table) in any order, down to the vitest import itself (`it`,
 * `vitest.it`).
 */
const declaredThrough = (context: Context, callee: Node): string | undefined => {
	let current = unwrap(callee);
	// `it.each(cases)` only builds the declaring function; the call it returns declares.
	const outer = propertyName(current);
	if (outer !== undefined && CURRIED.has(outer)) return undefined;
	for (;;) {
		if (current?.type === 'CallExpression' || current?.type === 'TaggedTemplateExpression') {
			const factory = unwrap(current.type === 'CallExpression' ? current.callee : current.tag);
			const name = propertyName(factory);
			if (factory?.type !== 'MemberExpression' || name === undefined || !CURRIED.has(name)) {
				return undefined;
			}
			current = unwrap(factory.object);
		} else if (current?.type === 'MemberExpression') {
			const name = propertyName(current);
			if (name === undefined) return undefined;
			if (
				TEST_FUNCTIONS.has(name) &&
				vitestImport(context, unwrap(current.object)) === 'namespace'
			) {
				return name;
			}
			if (!MODIFIERS.has(name)) return undefined;
			current = unwrap(current.object);
		} else {
			const imported = vitestImport(context, current);
			return imported !== undefined && TEST_FUNCTIONS.has(imported) ? imported : undefined;
		}
	}
};

const insideLoop = (node: AstNode): boolean => {
	let current: Node = node.parent;
	while (current) {
		if (LOOPS.has(current.type)) return true;
		if (FUNCTIONS.has(current.type)) return false;
		current = current.parent;
	}
	return false;
};

const rule: Rule = {
	meta: {
		type: 'suggestion',
		docs: {
			description:
				'Disallow declaring tests or suites inside a loop; use it.each / describe.each instead.',
		},
	},
	create(context) {
		if (!context.sourceCode.text.includes('vitest')) return {};
		return {
			CallExpression(node) {
				if (!insideLoop(node)) return;
				const name = declaredThrough(context, node.callee);
				if (name === undefined) return;
				context.report({
					node: node.callee,
					message: `Do not declare ${name}(…) inside a loop. Use ${name}.each(cases)(title, …) so every case has a stable, filterable name.`,
				});
			},
		};
	},
};

export default rule;
