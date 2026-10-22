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
/** Collections of the root's children. */
export const CHILD_COLLECTIONS = new Set(['childNodes', 'children']);
/** Reads of one child of the root, which a draining loop removes. */
const CHILD_READS = new Set(['firstChild', 'lastChild', 'firstElementChild', 'lastElementChild']);
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
	const isRootMember = (node: AstNode, names: Set<string>): boolean => {
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

	/**
	 * One child of the root: `<root>.firstChild` and kin, `<root>.children[i]`,
	 * `<root>.childNodes.item(i)`, or a never-reassigned alias of one.
	 */
	const isRootChild = (node: Node, depth = 0): boolean => {
		const current = unwrap(node);
		if (!current || depth > 8) return false;
		if (current.type === 'Identifier') {
			const alias = aliasOf(current);
			return alias !== undefined && 'value' in alias && isRootChild(alias.value, depth + 1);
		}
		if (current.type === 'MemberExpression') {
			if (isRootMember(current, CHILD_READS)) return true;
			const collection = unwrap(current.object);
			return (
				current.computed &&
				propertyName(current) === undefined &&
				collection !== undefined &&
				collection !== null &&
				isRootMember(collection, CHILD_COLLECTIONS)
			);
		}
		if (current.type !== 'CallExpression') return false;
		const callee = unwrap(current.callee);
		const collection = callee?.type === 'MemberExpression' ? unwrap(callee.object) : undefined;
		return (
			propertyName(callee) === 'item' &&
			collection !== undefined &&
			collection !== null &&
			isRootMember(collection, CHILD_COLLECTIONS)
		);
	};

	return { aliasOf, isRootChild, isRootElement, isRootMember, isVariable, localVariable };
};

export type RootMatcher = ReturnType<typeof createRootMatcher>;
