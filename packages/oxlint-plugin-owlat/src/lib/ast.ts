/**
 * AST helpers shared by the rules: unwrapping, static names, scope-resolved
 * bindings, a generic subtree walk and the comment opt-outs.
 */
import type { AstNode, Comment, Context, Scope } from '../types.ts';

export type Node = AstNode | null | undefined;

/** A node's fields, for the generic walk and for shapes the union does not narrow. */
type Fields = Record<string, unknown>;

const WRAPPERS = new Set([
	'ChainExpression',
	'ParenthesizedExpression',
	'TSNonNullExpression',
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSTypeAssertion',
	'TSInstantiationExpression',
]);

/** Strip parentheses, `?.` chains, non-null and type assertions. */
export const unwrap = (node: Node): Node => {
	let current = node;
	while (current && WRAPPERS.has(current.type)) {
		current = (current as unknown as Fields)['expression'] as Node;
	}
	return current;
};

const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration']);

/** The string a literal or an interpolation-free template spells, if it is one. */
export const staticString = (node: Node): string | undefined => {
	const current = unwrap(node);
	if (current?.type === 'Literal' && typeof current.value === 'string') return current.value;
	if (current?.type === 'TemplateLiteral' && current.expressions.length === 0) {
		return current.quasis[0]?.value.cooked ?? undefined;
	}
	return undefined;
};

/** `a.b` / `a['b']` / `a?.b`: the property name when it is static. */
export const memberName = (node: Node): string | undefined => {
	if (node?.type !== 'MemberExpression') return undefined;
	if (!node.computed && node.property.type === 'Identifier') return node.property.name;
	return node.computed ? staticString(node.property as AstNode) : undefined;
};

/** A property key's static name: `a`, `'a'`, `['a']`. */
export const keyName = (node: Node): string | undefined => {
	if (node?.type !== 'Property') return undefined;
	if (!node.computed && node.key.type === 'Identifier') return node.key.name;
	return staticString(node.key as AstNode);
};

/** The name a call is made through: `name(…)` or `x.name(…)`. */
export const calleeName = (callee: Node): string | undefined => {
	const current = unwrap(callee);
	if (current?.type === 'Identifier') return current.name;
	return memberName(current);
};

type Binding =
	/** `imported` is the exported name, `default`, or `*` for a namespace import. */
	| { type: 'import'; source: string; imported: string }
	/** `name` is the declared identifier, inside `declaration` (a pattern for destructuring). */
	| { type: 'local'; declaration: Node; name: Node }
	| { type: 'global' };

/** What an identifier refers to, resolved through scope. */
export const bindingOf = (context: Context, identifier: AstNode): Binding => {
	if (identifier.type !== 'Identifier') return { type: 'global' };
	let scope: Scope | null = context.sourceCode.getScope(identifier);
	while (scope) {
		const variable = scope.set.get(identifier.name);
		if (variable) {
			const definition = variable.defs[0];
			if (!definition) return { type: 'global' };
			const declaration = definition.parent;
			if (definition.type === 'ImportBinding' && declaration?.type === 'ImportDeclaration') {
				const specifier = definition.node;
				let imported = 'default';
				if (specifier.type === 'ImportNamespaceSpecifier') imported = '*';
				else if (specifier.type === 'ImportSpecifier') {
					imported =
						specifier.imported.type === 'Identifier'
							? specifier.imported.name
							: String(specifier.imported.value);
				}
				return { type: 'import', source: String(declaration.source.value), imported };
			}
			return { type: 'local', declaration: definition.node, name: definition.name as AstNode };
		}
		scope = scope.upper;
	}
	return { type: 'global' };
};

interface Imported {
	source: string;
	name: string;
}

/** Bound on alias chains (`const a = b; const b = c; …`), so a cycle cannot loop. */
const MAX_ALIAS_DEPTH = 8;

const sameNode = (a: Node, b: Node): boolean =>
	!!a && !!b && a.type === b.type && a.start === b.start && a.end === b.end;

/** The static key `{ key: name }`, `{ name }` or `{ key: name = fallback }` binds `name` under. */
export const destructuredKey = (pattern: Node, name: Node): string | undefined => {
	if (pattern?.type !== 'ObjectPattern') return undefined;
	for (const property of pattern.properties) {
		if (property.type !== 'Property') continue;
		let value = property.value as Node;
		if (value?.type === 'AssignmentPattern') value = value.left as Node;
		if (sameNode(value, name)) return keyName(property);
	}
	return undefined;
};

/**
 * The `VariableDeclarator` a local binding comes from, with the identifier it
 * declares; `alias` when the declarator binds that identifier alone
 * (`const x = <init>`, not a destructuring pattern).
 */
export const declaratorOf = (binding: Binding) =>
	binding.type === 'local' && binding.declaration?.type === 'VariableDeclarator'
		? {
				declarator: binding.declaration,
				name: binding.name,
				alias: binding.declaration.id.type === 'Identifier',
			}
		: undefined;

/**
 * The module a namespace import comes from, when `node` names one: the
 * namespace itself (`ns`) or a local alias of it (`const s = ns`).
 */
const namespaceSource = (context: Context, node: Node, depth = 0): string | undefined => {
	const current = unwrap(node);
	if (current?.type !== 'Identifier') return undefined;
	const binding = bindingOf(context, current);
	if (binding.type === 'import') return binding.imported === '*' ? binding.source : undefined;
	const local = declaratorOf(binding);
	if (!local?.alias || depth >= MAX_ALIAS_DEPTH) {
		return undefined;
	}
	return namespaceSource(context, local.declarator.init as AstNode, depth + 1);
};

/**
 * The module export an expression names: an imported binding (`x`, or `y as x`),
 * a member of a namespace import (`ns.x`, `ns['x']`), or a local alias of either
 * (`const z = x`, `const z = ns.x`, `const { x: z } = ns`, also through an alias
 * of the namespace).
 */
export const importedThrough = (context: Context, node: Node, depth = 0): Imported | undefined => {
	const current = unwrap(node);
	if (current?.type === 'Identifier') {
		const binding = bindingOf(context, current);
		if (binding.type === 'import') {
			return binding.imported !== '*'
				? { source: binding.source, name: binding.imported }
				: undefined;
		}
		const local = declaratorOf(binding);
		if (!local || depth >= MAX_ALIAS_DEPTH) return undefined;
		const { id, init } = local.declarator;
		if (local.alias) {
			return importedThrough(context, init as AstNode, depth + 1);
		}
		const key = destructuredKey(id as AstNode, local.name);
		const source =
			key === undefined ? undefined : namespaceSource(context, init as AstNode, depth + 1);
		return source === undefined || key === undefined ? undefined : { source, name: key };
	}
	const name = memberName(current);
	if (current?.type !== 'MemberExpression' || name === undefined) return undefined;
	const source = namespaceSource(context, current.object as AstNode, depth);
	return source === undefined ? undefined : { source, name };
};

/**
 * The name a call resolves to for name-keyed checks: the imported name through
 * any alias or namespace, otherwise the identifier as written (a local
 * declaration or a global), followed through a local alias (`const f = g`).
 */
export const resolvedName = (context: Context, callee: Node, depth = 0): string | undefined => {
	const imported = importedThrough(context, callee);
	if (imported) return imported.name;
	const current = unwrap(callee);
	if (current?.type !== 'Identifier') return undefined;
	const local = declaratorOf(bindingOf(context, current));
	const init = unwrap(local?.declarator.init as Node);
	if (local?.alias && depth < MAX_ALIAS_DEPTH && init?.type === 'Identifier') {
		return resolvedName(context, init, depth + 1);
	}
	return current.name;
};

/**
 * Visit every node under `root` (itself included) in source order, without
 * entering a nested function when `skipFunctions` is set. `visit` returning
 * `false` stops the walk below that node.
 */
export const walk = (
	context: Context,
	root: Node,
	visit: (node: AstNode) => boolean | void,
	{ skipFunctions = false }: { skipFunctions?: boolean } = {}
): void => {
	const keys = context.sourceCode.visitorKeys;
	const stack: AstNode[] = root ? [root] : [];
	while (stack.length > 0) {
		const node = stack.pop() as AstNode;
		if (visit(node) === false) continue;
		const children: AstNode[] = [];
		for (const key of keys[node.type] ?? []) {
			const value = (node as unknown as Fields)[key];
			if (Array.isArray(value)) {
				for (const item of value) if (item && typeof item === 'object') children.push(item);
			} else if (value && typeof value === 'object' && 'type' in value) {
				children.push(value as AstNode);
			}
		}
		for (let index = children.length - 1; index >= 0; index--) {
			const child = children[index] as AstNode;
			if (skipFunctions && FUNCTIONS.has(child.type)) continue;
			stack.push(child);
		}
	}
};

/** `true` when `node` sits inside `ancestor` (by source range). */
export const within = (
	node: { start: number; end: number },
	ancestor: { start: number; end: number }
): boolean => node.start >= ancestor.start && node.end <= ancestor.end;

const ownLineComments = new WeakMap<object, Map<number, Comment>>();

/** Line comments that start their own line, keyed by line number. */
const commentLines = (context: Context): Map<number, Comment> => {
	const { sourceCode } = context;
	const cached = ownLineComments.get(sourceCode.ast);
	if (cached) return cached;
	const byLine = new Map<number, Comment>();
	for (const comment of sourceCode.getAllComments()) {
		if (comment.type !== 'Line') continue;
		const { line, column } = comment.loc.start;
		if ((sourceCode.lines[line - 1] ?? '').slice(0, column).trim() === '') {
			byLine.set(line, comment);
		}
	}
	ownLineComments.set(sourceCode.ast, byLine);
	return byLine;
};

/** `// <keyword>: <reason>` with a non-empty reason. */
const optOutPattern = (keyword: string): RegExp => new RegExp(`^\\s*${keyword}:\\s*\\S`, 'u');

/**
 * An opt-out applies to `node` when a `// <keyword>: <reason>` line comment sits
 * inside it, or in the run of comment-only lines directly above the line it
 * starts on. A blank line or a line of code ends that run, so a note never
 * carries onto a later, unrelated statement.
 */
export const optedOut = (context: Context, node: AstNode, keyword: string): boolean => {
	const pattern = optOutPattern(keyword);
	for (const comment of context.sourceCode.getAllComments()) {
		if (comment.type === 'Line' && within(comment, node) && pattern.test(comment.value)) {
			return true;
		}
	}
	const byLine = commentLines(context);
	for (let line = node.loc.start.line - 1; byLine.has(line); line--) {
		if (pattern.test((byLine.get(line) as Comment).value)) return true;
	}
	return false;
};
