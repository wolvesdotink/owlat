import type { AstNode, Context, Scope } from './types.ts';

/**
 * Resolves calls to vitest's own API, shared by the rules that police tests.
 *
 * Only callees bound to an import from `vitest` count (globals are off in this
 * repository), so an unrelated function that happens to be called `it` or
 * `beforeAll` is never flagged.
 */

export type Node = AstNode | null | undefined;

const TEST_FUNCTIONS = new Set(['it', 'test', 'describe', 'suite']);
const MODIFIERS = new Set(['only', 'skip', 'todo', 'concurrent', 'sequential', 'fails', 'shuffle']);
const CURRIED = new Set(['each', 'for', 'skipIf', 'runIf', 'extend']);
const WRAPPERS = new Set([
	'ChainExpression',
	'ParenthesizedExpression',
	'TSNonNullExpression',
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSTypeAssertion',
]);

export const unwrap = (node: Node): Node => {
	let current = node;
	while (current && WRAPPERS.has(current.type) && 'expression' in current) {
		current = current.expression as Node;
	}
	return current;
};

/** The name of a static property access (`a.b` or `a['b']`). */
export const propertyName = (node: Node): string | undefined => {
	if (node?.type !== 'MemberExpression') return undefined;
	const { property } = node;
	if (!node.computed && property.type === 'Identifier') return property.name;
	if (property.type === 'Literal' && typeof property.value === 'string') return property.value;
	return undefined;
};

/** The variable an identifier refers to, searched from its own scope outwards. */
export const resolveVariable = (context: Context, identifier: Node) => {
	if (identifier?.type !== 'Identifier') return undefined;
	let scope: Scope | null = context.sourceCode.getScope(identifier);
	while (scope) {
		const variable = scope.set.get(identifier.name);
		if (variable) return variable;
		scope = scope.upper;
	}
	return undefined;
};

/**
 * What an identifier is imported as from a module whose specifier passes
 * `fromModule`: the imported export's name, or `namespace` for `import * as`.
 */
export const importedName = (
	context: Context,
	identifier: Node,
	fromModule: (specifier: string) => boolean
): string | undefined => {
	const definition = resolveVariable(context, identifier)?.defs[0];
	const declaration = definition?.parent;
	if (
		definition?.type !== 'ImportBinding' ||
		declaration?.type !== 'ImportDeclaration' ||
		typeof declaration.source.value !== 'string' ||
		!fromModule(declaration.source.value)
	) {
		return undefined;
	}
	const specifier = definition.node;
	if (specifier.type === 'ImportNamespaceSpecifier') return 'namespace';
	if (specifier.type !== 'ImportSpecifier') return undefined;
	const { imported } = specifier;
	return imported.type === 'Identifier' ? imported.name : String(imported.value);
};

const isVitest = (specifier: string) => specifier === 'vitest';

/**
 * The vitest export a callee names: a bare imported binding (`beforeAll`, an
 * aliased `it as spec`) or a member of the namespace import (`vitest.it`).
 */
export const vitestExport = (context: Context, node: Node): string | undefined => {
	const current = unwrap(node);
	if (current?.type === 'MemberExpression') {
		const name = propertyName(current);
		return name !== undefined &&
			importedName(context, unwrap(current.object), isVitest) === 'namespace'
			? name
			: undefined;
	}
	const imported = importedName(context, current, isVitest);
	return imported === 'namespace' ? undefined : imported;
};

interface Declaration {
	/** The vitest function the chain starts from: `it`, `test`, `describe` or `suite`. */
	readonly root: string;
	/** The modifier accesses on the way (`.skip`, `.only`, …), outermost first. */
	readonly modifiers: readonly { name: string; node: AstNode }[];
	/** The curried factory calls on the way (`.each(…)`, `.skipIf(…)`, …), outermost first. */
	readonly factories: readonly { name: string; node: AstNode; args: readonly AstNode[] }[];
}

/**
 * The test or suite a call declares, read off its callee from the outside in:
 * modifiers (`.only`, `.skip.concurrent`), factory calls (`.each(cases)`,
 * `.skipIf(cond)`, `.extend(fixtures)`) and tagged-template tables (`.each`
 * with a template table) in any order, down to the vitest import itself (`it`,
 * `vitest.it`). Undefined for anything else, including `it.each(cases)` on its
 * own: that call only builds the declaring function, the call it returns
 * declares.
 */
export const declarationOf = (context: Context, callee: Node): Declaration | undefined => {
	let current = unwrap(callee);
	const outer = propertyName(current);
	if (outer !== undefined && CURRIED.has(outer)) return undefined;
	const modifiers: { name: string; node: AstNode }[] = [];
	const factories: { name: string; node: AstNode; args: readonly AstNode[] }[] = [];
	for (;;) {
		if (current?.type === 'CallExpression' || current?.type === 'TaggedTemplateExpression') {
			const factory = unwrap(current.type === 'CallExpression' ? current.callee : current.tag);
			const name = propertyName(factory);
			if (factory?.type !== 'MemberExpression' || name === undefined || !CURRIED.has(name)) {
				return undefined;
			}
			factories.push({
				name,
				node: factory,
				args: current.type === 'CallExpression' ? (current.arguments as AstNode[]) : [],
			});
			current = unwrap(factory.object);
		} else if (current?.type === 'MemberExpression') {
			const name = propertyName(current);
			if (name === undefined) return undefined;
			if (
				TEST_FUNCTIONS.has(name) &&
				importedName(context, unwrap(current.object), isVitest) === 'namespace'
			) {
				return { root: name, modifiers, factories };
			}
			if (!MODIFIERS.has(name)) return undefined;
			modifiers.push({ name, node: current });
			current = unwrap(current.object);
		} else {
			const imported = importedName(context, current, isVitest);
			return imported !== undefined && TEST_FUNCTIONS.has(imported)
				? { root: imported, modifiers, factories }
				: undefined;
		}
	}
};
