/**
 * AST and scope helpers the rules share. Bindings are resolved through scope,
 * never by name alone, so a local that shadows an import or a global is never
 * mistaken for it.
 */
import type { AstNode, Context, Scope } from './types.ts';

export type Node = AstNode | null | undefined;
export type Variable = Scope['variables'][number];

export const FUNCTIONS = new Set([
	'ArrowFunctionExpression',
	'FunctionExpression',
	'FunctionDeclaration',
]);

const WRAPPERS = new Set([
	'ChainExpression',
	'ParenthesizedExpression',
	'TSNonNullExpression',
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSTypeAssertion',
]);

/** The body of a function node (a block, or an arrow's expression); undefined for anything else. */
export const functionBody = (node: AstNode): Node =>
	node.type === 'ArrowFunctionExpression' ||
	node.type === 'FunctionExpression' ||
	node.type === 'FunctionDeclaration'
		? node.body
		: undefined;

/** A test file: `*.test.*` / `*.spec.*`, or any file under a `__tests__` directory. */
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|[\\/])__tests__[\\/])/u;

export const isTestFile = (filename: string): boolean => TEST_FILE.test(filename);

/** The expression under parentheses, `!`, `as`, `satisfies` and optional chains. */
export const unwrap = (node: Node): Node => {
	let current = node;
	while (current && WRAPPERS.has(current.type) && 'expression' in current) {
		current = current.expression as Node;
	}
	return current;
};

/** The static name a member expression reads (`a.b`, `a['b']`), if it has one. */
export const propertyName = (node: Node): string | undefined => {
	if (node?.type !== 'MemberExpression') return undefined;
	const { property } = node;
	if (!node.computed && property.type === 'Identifier') return property.name;
	if (property.type === 'Literal' && typeof property.value === 'string') return property.value;
	return undefined;
};

/** The variable an identifier resolves to, or undefined for an unbound (global) name. */
export const variableOf = (context: Context, identifier: Node): Variable | undefined => {
	if (identifier?.type !== 'Identifier') return undefined;
	let scope: Scope | null = context.sourceCode.getScope(identifier);
	while (scope) {
		const variable = scope.set.get(identifier.name);
		if (variable) return variable.defs.length > 0 ? variable : undefined;
		scope = scope.upper;
	}
	return undefined;
};

/** An identifier with the given name that no declaration in the file shadows. */
export const isGlobal = (context: Context, node: Node, names: ReadonlySet<string>): boolean => {
	const identifier = unwrap(node);
	return (
		identifier?.type === 'Identifier' &&
		names.has(identifier.name) &&
		variableOf(context, identifier) === undefined
	);
};

export interface ImportedBinding {
	source: string;
	/** The exported name, `*` for a namespace import, `default` for a default import. */
	imported: string;
}

/** The module and export an identifier is imported from, if it is an import binding. */
export const importOf = (context: Context, identifier: Node): ImportedBinding | undefined => {
	const definition = variableOf(context, identifier)?.defs[0];
	const declaration = definition?.parent;
	if (definition?.type !== 'ImportBinding' || declaration?.type !== 'ImportDeclaration') {
		return undefined;
	}
	const source = declaration.source.value;
	const specifier = definition.node;
	if (specifier.type === 'ImportNamespaceSpecifier') return { source, imported: '*' };
	if (specifier.type === 'ImportDefaultSpecifier') return { source, imported: 'default' };
	if (specifier.type !== 'ImportSpecifier') return undefined;
	const { imported } = specifier;
	return { source, imported: imported.type === 'Identifier' ? imported.name : imported.value };
};

/** The vitest export an identifier is bound to, or `namespace` for `import * as`. */
export const vitestImport = (context: Context, identifier: Node): string | undefined => {
	const binding = importOf(context, identifier);
	if (binding?.source !== 'vitest') return undefined;
	return binding.imported === '*' ? 'namespace' : binding.imported;
};

/** The `vi` method a member expression names: `vi.x`, `vitest.vi.x`, or an aliased `vi`. */
export const viMethod = (context: Context, node: Node): string | undefined => {
	const member = unwrap(node);
	const name = propertyName(member);
	if (name === undefined || member?.type !== 'MemberExpression') return undefined;
	const object = unwrap(member.object);
	if (vitestImport(context, object) === 'vi') return name;
	if (
		propertyName(object) === 'vi' &&
		object?.type === 'MemberExpression' &&
		vitestImport(context, unwrap(object.object)) === 'namespace'
	) {
		return name;
	}
	return undefined;
};

/** The nearest function around `node`, or the Program when it sits at module level. */
export const enclosingFunction = (node: AstNode): AstNode => {
	let current: AstNode = node;
	while (current.parent) {
		current = current.parent;
		if (FUNCTIONS.has(current.type)) return current;
	}
	return current;
};

/** Whether `inner` lies inside `outer`'s source range. */
export const contains = (outer: AstNode, inner: AstNode): boolean =>
	outer.start <= inner.start && inner.end <= outer.end;

export type VisitorKeys = Context['sourceCode']['visitorKeys'];

/**
 * Whether `node` or a descendant matches, not descending into nested functions:
 * code in a callback runs on the callback's schedule, not the caller's. Children
 * are read through the parser's visitor keys, so only AST edges are followed.
 */
export const someDescendant = (
	keys: VisitorKeys,
	node: Node,
	match: (node: AstNode) => boolean
): boolean => {
	if (!node) return false;
	if (match(node)) return true;
	if (FUNCTIONS.has(node.type)) return false;
	for (const key of keys[node.type] ?? []) {
		const child = (node as unknown as Record<string, unknown>)[key];
		const children = (Array.isArray(child) ? child : [child]) as Node[];
		if (children.some((each) => someDescendant(keys, each, match))) return true;
	}
	return false;
};
