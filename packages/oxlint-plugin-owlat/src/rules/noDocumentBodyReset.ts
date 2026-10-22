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
 *  - a loop that drains it (`while (document.body.firstChild)` removing
 *    `document.body.firstChild`), and a `for…of` or `.forEach` over its
 *    children (or its `'*'` descendants) that removes the node it is visiting.
 * A loop only counts when it removes the root's own children: `.remove()` on
 * them or `.removeChild(…)` with them as the argument. Removing a node found
 * inside a child, or some unrelated node, leaves the rest of the document in
 * place and stays allowed.
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
/** Reads of one child of the root, which a draining loop removes. */
const CHILD_READS = new Set(['firstChild', 'lastChild', 'firstElementChild', 'lastElementChild']);
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

	type Variable = NonNullable<ReturnType<typeof localVariable>>;

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

	/**
	 * Whether `node` removes a node `isTarget` accepts: `target.remove()` or
	 * `parent.removeChild(target)`. A removal of anything else (a node queried
	 * inside the target, an owned fixture) does not count.
	 */
	const removes = (node: Node, isTarget: (candidate: Node) => boolean) =>
		containsNode(node, (candidate) => {
			if (candidate.type !== 'CallExpression') return false;
			const callee = unwrap(candidate.callee);
			if (callee?.type !== 'MemberExpression') return false;
			const name = propertyName(callee);
			// `remove(index)` is HTMLSelectElement's option removal, not the node's own.
			if (name === 'remove') return candidate.arguments.length === 0 && isTarget(callee.object);
			return name === 'removeChild' && isTarget(candidate.arguments[0]);
		});

	/** Whether `body` removes the node a loop binds to `binding` on each pass. */
	const removesVisited = (body: Node, binding: Node) => {
		const variable = binding?.type === 'Identifier' ? localVariable(binding) : undefined;
		return variable !== undefined && removes(body, (candidate) => isVariable(candidate, variable));
	};

	/**
	 * Whether a loop with this `test` and `body` removes the root's children:
	 * one read straight off the root, or a variable the test assigns one to
	 * (`while ((node = document.body.firstChild)) node.remove()`).
	 */
	const removesRootChildren = (test: Node, body: Node) => {
		const assigned: Variable[] = [];
		containsNode(test, (candidate) => {
			if (
				candidate.type === 'AssignmentExpression' &&
				candidate.operator === '=' &&
				candidate.left.type === 'Identifier' &&
				isRootChild(candidate.right)
			) {
				const variable = localVariable(candidate.left);
				if (variable) assigned.push(variable);
			}
			return false;
		});
		return removes(
			body,
			(candidate) =>
				isRootChild(candidate) || assigned.some((variable) => isVariable(candidate, variable))
		);
	};

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

	return { isRootElement, isRootMember, removesRootChildren, removesVisited, walksRootChildren };
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
		const { isRootElement, isRootMember, removesRootChildren, removesVisited, walksRootChildren } =
			createMatcher(context);
		const report = (node: AstNode) => context.report({ node, message: MESSAGE });

		/** A loop that keeps removing nodes while the body still has children. */
		const checkDrainingLoop = (node: AstNode) => {
			if (!('test' in node) || !('body' in node)) return;
			const probesChildren = containsNode(node.test as Node, (candidate) =>
				isRootMember(candidate, CHILD_PROBES)
			);
			if (probesChildren && removesRootChildren(node.test as Node, node.body as Node)) report(node);
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
				const [callback] = node.arguments;
				if (
					propertyName(callee) === 'forEach' &&
					callee?.type === 'MemberExpression' &&
					(callback?.type === 'ArrowFunctionExpression' ||
						callback?.type === 'FunctionExpression') &&
					walksRootChildren(callee.object) &&
					removesVisited(callback.body, callback.params[0])
				) {
					report(node);
				}
			},
			ForOfStatement(node) {
				const { left } = node;
				const binding =
					left.type === 'VariableDeclaration' ? left.declarations[0]?.id : unwrap(left);
				if (walksRootChildren(node.right) && removesVisited(node.body, binding)) report(node);
			},
			WhileStatement: checkDrainingLoop,
			DoWhileStatement: checkDrainingLoop,
			ForStatement: checkDrainingLoop,
		};
	},
};

export default rule;
