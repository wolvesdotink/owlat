import { matchesAnyGlob } from '../fileGlobs.ts';
import type { AstNode, Context, Rule, Scope } from '../types.ts';

/**
 * A test never wipes the whole document to clean up after itself. Clearing
 * `document.body` removes a component's DOM but leaves the component mounted:
 * its watchers, its window and document listeners and its place on shared
 * stacks (focus, toasts, shortcuts) live on into the next test, and the next
 * test's fresh body hides that leak. The shared vitest setup unmounts every
 * mounted component after each test instead; a test that builds DOM by hand
 * appends it to a node it owns and removes that node.
 *
 * Every way of replacing the body's (or the root element's) whole content is
 * reported, not just one spelling:
 *  - assigning `innerHTML` / `outerHTML` / `textContent` / `innerText`, with
 *    any operator and through a computed key (`body['innerHTML'] = ''`);
 *  - calling `replaceChildren`, `replaceWith`, `setHTML` or `setHTMLUnsafe`;
 *  - a loop that drains it (`while (document.body.firstChild) …remove…`), and
 *    a `for…of` or `.forEach` over its children (or its `'*'` descendants)
 *    that removes them.
 * The body is recognized as `document.body` / `document.documentElement`
 * (also through `window.`, `globalThis.` or `self.`, computed keys and
 * TypeScript non-null or `as` wrappers) and through a local variable that is
 * never reassigned and holds it, destructuring included (`const { body } =
 * document`). Appending to the body, removing one owned node and reading the
 * body's markup stay allowed.
 *
 * Options: `files` limits the rule to repository-relative globs (see
 * `fileGlobs.ts`); without it the rule applies to every linted file.
 */

interface Options {
	files?: string[];
}

const ROOT_ELEMENTS = new Set(['body', 'documentElement']);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);
const CONTENT_PROPERTIES = new Set(['innerHTML', 'outerHTML', 'textContent', 'innerText']);
const REPLACING_METHODS = new Set(['replaceChildren', 'replaceWith', 'setHTML', 'setHTMLUnsafe']);
/** Reads that tell a loop whether the body still has children. */
const CHILD_PROBES = new Set([
	'firstChild',
	'lastChild',
	'firstElementChild',
	'lastElementChild',
	'childElementCount',
	'childNodes',
	'children',
	'hasChildNodes',
]);
/** Collections of the body's children a loop can walk. */
const CHILD_COLLECTIONS = new Set(['childNodes', 'children']);
/** Queries that list every descendant when asked for `'*'`. */
const WILDCARD_QUERIES = new Set(['querySelectorAll', 'getElementsByTagName']);
const REMOVING_METHODS = new Set(['remove', 'removeChild']);
const WRAPPERS = new Set([
	'ChainExpression',
	'ParenthesizedExpression',
	'TSNonNullExpression',
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSTypeAssertion',
]);

const MESSAGE =
	'Do not reset the whole document in a test: it hides components a test left mounted. The shared vitest setup unmounts every mount after each test; append hand-built DOM to a node you own and remove that node.';

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
const containsNode = (node: Node, test: (candidate: AstNode) => boolean): boolean => {
	if (!node) return false;
	const stack: AstNode[] = [node];
	while (stack.length > 0) {
		const current = stack.pop() as AstNode;
		if (test(current)) return true;
		for (const child of childNodes(current)) stack.push(child);
	}
	return false;
};

const createMatcher = (context: Context) => {
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

	const removesNodes = (node: Node) =>
		containsNode(node, (candidate) => {
			if (candidate.type !== 'CallExpression') return false;
			const name = propertyName(unwrap(candidate.callee));
			return name !== undefined && REMOVING_METHODS.has(name);
		});

	const walksRootChildren = (node: Node) =>
		containsNode(node, (candidate) => {
			if (isRootMember(candidate, CHILD_COLLECTIONS)) return true;
			if (candidate.type !== 'CallExpression') return false;
			const callee = unwrap(candidate.callee);
			const [selector] = candidate.arguments;
			return (
				callee !== undefined &&
				callee !== null &&
				isRootMember(callee, WILDCARD_QUERIES) &&
				selector?.type === 'Literal' &&
				selector.value === '*'
			);
		});

	return { isRootElement, isRootMember, removesNodes, walksRootChildren };
};

const rule: Rule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Disallow clearing or replacing the whole document body in tests; unmount components and remove owned nodes instead.',
		},
		schema: [
			{
				type: 'object',
				properties: {
					files: { type: 'array', items: { type: 'string' } },
				},
				additionalProperties: false,
			},
		],
	},
	create(context) {
		const files = (context.options[0] as Options | undefined)?.files;
		if (files && !matchesAnyGlob(context.filename, files)) return {};
		if (!context.sourceCode.text.includes('document')) return {};
		const { isRootElement, isRootMember, removesNodes, walksRootChildren } = createMatcher(context);
		const report = (node: AstNode) => context.report({ node, message: MESSAGE });

		/** A loop that keeps removing nodes while the body still has children. */
		const checkDrainingLoop = (node: AstNode) => {
			if (!('test' in node) || !('body' in node)) return;
			const probesChildren = containsNode(node.test as Node, (candidate) =>
				isRootMember(candidate, CHILD_PROBES)
			);
			if (probesChildren && removesNodes(node.body as Node)) report(node);
		};

		return {
			AssignmentExpression(node) {
				const target = unwrap(node.left);
				const name = propertyName(target);
				if (
					name !== undefined &&
					CONTENT_PROPERTIES.has(name) &&
					target?.type === 'MemberExpression' &&
					isRootElement(target.object)
				) {
					report(node);
				}
			},
			CallExpression(node) {
				const callee = unwrap(node.callee);
				if (callee && isRootMember(callee, REPLACING_METHODS)) {
					report(node);
					return;
				}
				if (
					propertyName(callee) === 'forEach' &&
					callee?.type === 'MemberExpression' &&
					walksRootChildren(callee.object) &&
					removesNodes(node.arguments[0])
				) {
					report(node);
				}
			},
			ForOfStatement(node) {
				if (walksRootChildren(node.right) && removesNodes(node.body)) report(node);
			},
			WhileStatement: checkDrainingLoop,
			DoWhileStatement: checkDrainingLoop,
			ForStatement: checkDrainingLoop,
		};
	},
};

export default rule;
