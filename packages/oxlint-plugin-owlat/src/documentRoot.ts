import type { AstNode, Context, Scope } from './types.ts';

/**
 * Recognizing `document.body` / `document.documentElement` and reads of their
 * children in a lint rule's AST, however a test spells them: through
 * `window.` / `globalThis.` / `self.`, computed keys, TypeScript non-null or
 * `as` wrappers, and local variables that are never reassigned (destructuring
 * included).
 */

const ROOT_ELEMENTS = new Set(['body', 'documentElement']);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);
/** Which children a read or count covers: every child node, or elements only. */
export type ChildKind = 'node' | 'element';
/** Reads of the root's first or last child, of the kind each covers. */
const END_CHILD_READS = new Map<string, ChildKind>([
	['firstChild', 'node'],
	['lastChild', 'node'],
	['firstElementChild', 'element'],
	['lastElementChild', 'element'],
]);
/** The kind of child each collection of the root's children holds. */
const COLLECTION_KINDS = new Map<string, ChildKind>([
	['childNodes', 'node'],
	['children', 'element'],
]);
/** A binding the scope manager resolved. */
export type Variable = NonNullable<ReturnType<Scope['set']['get']>>;

const WRAPPERS = new Set([
	'ChainExpression',
	'ParenthesizedExpression',
	'TSNonNullExpression',
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSTypeAssertion',
]);

export type Node = AstNode | null | undefined;

export const unwrap = (node: Node): Node => {
	let current = node;
	while (current && WRAPPERS.has(current.type) && 'expression' in current) {
		current = current.expression as Node;
	}
	return current;
};

export const propertyName = (node: Node): string | undefined => {
	if (node?.type !== 'MemberExpression') return undefined;
	const { property } = node;
	if (!node.computed && property.type === 'Identifier') return property.name;
	if (property.type === 'Literal' && typeof property.value === 'string') return property.value;
	if (
		property.type === 'TemplateLiteral' &&
		property.expressions.length === 0 &&
		property.quasis.length === 1
	) {
		return property.quasis[0]?.value.cooked ?? undefined;
	}
	return undefined;
};

/** Every child node of `node`, in no particular order. */
function* childNodes(node: AstNode): Generator<AstNode> {
	for (const [key, value] of Object.entries(node)) {
		if (key === 'parent') continue;
		const items: unknown[] = Array.isArray(value) ? value : [value];
		for (const item of items) {
			if (item && typeof item === 'object' && typeof (item as AstNode).type === 'string') {
				yield item as AstNode;
			}
		}
	}
}

/** Whether `node` or anything inside it (nested functions included) satisfies `test`. */
export const containsNode = (node: Node, test: (candidate: AstNode) => boolean): boolean => {
	if (!node) return false;
	const stack: AstNode[] = [node];
	while (stack.length > 0) {
		const current = stack.pop() as AstNode;
		if (test(current)) return true;
		for (const child of childNodes(current)) stack.push(child);
	}
	return false;
};

/** Whether `node` lies inside `container`'s source range. */
const within = (node: AstNode, container: AstNode) =>
	node.range[0] >= container.range[0] && node.range[1] <= container.range[1];

/** The number literal `0`. */
const isZero = (node: Node) => {
	const current = unwrap(node);
	return current?.type === 'Literal' && current.value === 0;
};

export const createRootMatcher = (context: Context) => {
	/**
	 * The binding `identifier` resolves to, if the file declares it. Globals the
	 * config provides (`document`, `window` under the browser env) sit in the
	 * global scope with no definition and count as undeclared.
	 */
	const localVariable = (identifier: AstNode) => {
		if (identifier.type !== 'Identifier') return undefined;
		let scope: Scope | null = context.sourceCode.getScope(identifier);
		while (scope) {
			const variable = scope.set.get(identifier.name);
			if (variable) return variable.defs.length > 0 ? variable : undefined;
			scope = scope.upper;
		}
		return undefined;
	};

	/**
	 * What a never-reassigned local variable holds: its initializer, or for a
	 * `const { body } = document` binding the object and key it was taken from.
	 */
	const aliasOf = (identifier: AstNode) => {
		const variable = localVariable(identifier);
		const definition = variable?.defs[0];
		if (!variable || variable.defs.length !== 1 || definition?.type !== 'Variable') {
			return undefined;
		}
		if (variable.references.some((reference) => reference.isWrite() && !reference.init)) {
			return undefined;
		}
		const declarator = definition.node;
		if (declarator.type !== 'VariableDeclarator' || !declarator.init) return undefined;
		if (declarator.id === definition.name) return { value: declarator.init };
		const property = definition.name.parent;
		if (
			property?.type === 'Property' &&
			property.value === definition.name &&
			property.parent === declarator.id &&
			declarator.id.type === 'ObjectPattern'
		) {
			const key =
				!property.computed && property.key.type === 'Identifier'
					? property.key.name
					: property.key.type === 'Literal' && typeof property.key.value === 'string'
						? property.key.value
						: undefined;
			if (key !== undefined) return { object: declarator.init, key };
		}
		return undefined;
	};

	const isDocument = (node: Node, depth = 0): boolean => {
		const current = unwrap(node);
		if (!current || depth > 8) return false;
		if (current.type === 'Identifier') {
			if (current.name === 'document' && !localVariable(current)) return true;
			const alias = aliasOf(current);
			if (alias && 'value' in alias) return isDocument(alias.value, depth + 1);
			if (alias?.key === 'document') return isGlobalObject(alias.object);
			return false;
		}
		return (
			current.type === 'MemberExpression' &&
			propertyName(current) === 'document' &&
			isGlobalObject(current.object)
		);
	};

	const isGlobalObject = (node: Node): boolean => {
		const current = unwrap(node);
		return (
			current?.type === 'Identifier' && GLOBAL_OBJECTS.has(current.name) && !localVariable(current)
		);
	};

	/** `document.body` / `document.documentElement`, however it is spelled. */
	const isRootElement = (node: Node, depth = 0): boolean => {
		const current = unwrap(node);
		if (!current || depth > 8) return false;
		if (current.type === 'Identifier') {
			const alias = aliasOf(current);
			if (alias && 'value' in alias) return isRootElement(alias.value, depth + 1);
			return alias !== undefined && ROOT_ELEMENTS.has(alias.key) && isDocument(alias.object);
		}
		const name = propertyName(current);
		return (
			current.type === 'MemberExpression' &&
			name !== undefined &&
			ROOT_ELEMENTS.has(name) &&
			isDocument(current.object)
		);
	};

	/** A member read `<root>.<name>` with `name` in `names`. */
	const isRootMember = (node: AstNode, names: Pick<ReadonlySet<string>, 'has'>): boolean => {
		const name = propertyName(node);
		return (
			name !== undefined &&
			names.has(name) &&
			node.type === 'MemberExpression' &&
			isRootElement(node.object)
		);
	};

	/** Whether `node` is `variable`, directly or through never-reassigned aliases. */
	const isVariable = (node: Node, variable: Variable, depth = 0): boolean => {
		const current = unwrap(node);
		if (current?.type !== 'Identifier' || depth > 8) return false;
		if (localVariable(current) === variable) return true;
		const alias = aliasOf(current);
		return alias !== undefined && 'value' in alias && isVariable(alias.value, variable, depth + 1);
	};

	/** The kind of child `<root>.childNodes` / `<root>.children` holds, if `node` is one. */
	const rootCollectionKind = (node: Node): ChildKind | undefined => {
		const current = unwrap(node);
		const name = propertyName(current);
		return current && name !== undefined && isRootMember(current, COLLECTION_KINDS)
			? COLLECTION_KINDS.get(name)
			: undefined;
	};

	/**
	 * The kind of child `node` reads if it is the root's first or last child,
	 * which exists exactly while the root has a child of that kind:
	 * `<root>.firstChild` and kin, `<root>.children[0]`,
	 * `<root>.childNodes.item(0)`. Any other index (`children[1]`) may be empty
	 * while earlier children remain, so it is not an end child. A local alias
	 * holds a snapshot that stays set after its node is removed, so it only
	 * counts when it is declared inside `freshIn` (a loop body, which reads it
	 * again on every pass).
	 */
	const endChildKind = (node: Node, freshIn?: Node, depth = 0): ChildKind | undefined => {
		const current = unwrap(node);
		if (!current || depth > 8) return undefined;
		if (current.type === 'Identifier') {
			const declared = localVariable(current)?.defs[0]?.node;
			if (!freshIn || !declared || !within(declared, freshIn)) return undefined;
			const alias = aliasOf(current);
			return alias !== undefined && 'value' in alias
				? endChildKind(alias.value, freshIn, depth + 1)
				: undefined;
		}
		if (current.type === 'MemberExpression') {
			const name = propertyName(current);
			if (name !== undefined && isRootMember(current, END_CHILD_READS)) {
				return END_CHILD_READS.get(name);
			}
			return current.computed && isZero(current.property)
				? rootCollectionKind(current.object)
				: undefined;
		}
		if (current.type !== 'CallExpression') return undefined;
		const callee = unwrap(current.callee);
		return callee?.type === 'MemberExpression' &&
			propertyName(callee) === 'item' &&
			current.arguments.length === 1 &&
			isZero(current.arguments[0])
			? rootCollectionKind(callee.object)
			: undefined;
	};

	return {
		aliasOf,
		endChildKind,
		isRootElement,
		isRootMember,
		isVariable,
		localVariable,
		rootCollectionKind,
	};
};

export type RootMatcher = ReturnType<typeof createRootMatcher>;
