import {
	CHILD_COLLECTIONS,
	containsNode,
	type Node,
	propertyName,
	type RootMatcher,
	unwrap,
	type Variable,
} from './documentRoot.ts';

/**
 * Recognizing loops that empty `document.body` / `document.documentElement`:
 * a `while` / `do` / `for` loop that drains it, and a `for…of` or `.forEach`
 * over its children that removes each one. A loop only counts when it removes
 * every child, so a loop that may leave some in place is not matched.
 */

/** Counts of the root's children a draining loop tests. */
const CHILD_COUNTS = new Set(['childElementCount']);
/** The call that tells a draining loop whether the root still has children. */
const HAS_CHILDREN = new Set(['hasChildNodes']);
const NOT_EQUAL = new Set(['!==', '!=']);
/** The operator that keeps a comparison's meaning with its operands swapped. */
const MIRRORED_OPERATORS: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' };
/** Statements that can end a loop pass before its removal or skip later passes. */
const EARLY_EXITS = new Set([
	'BreakStatement',
	'ContinueStatement',
	'ReturnStatement',
	'ThrowStatement',
]);
/** Queries that list every descendant when asked for `'*'`. */
const WILDCARD_QUERIES = new Set(['querySelectorAll', 'getElementsByTagName']);

export const createLoopMatcher = ({
	isRootChild,
	isRootMember,
	isVariable,
	localVariable,
	aliasOf,
}: RootMatcher) => {
	/** Whether `node` is `target.remove()` or `parent.removeChild(target)` for a target `isTarget` accepts. */
	const isRemovalOf = (node: Node, isTarget: (candidate: Node) => boolean) => {
		const call = unwrap(node);
		if (call?.type !== 'CallExpression') return false;
		const callee = unwrap(call.callee);
		if (callee?.type !== 'MemberExpression') return false;
		const name = propertyName(callee);
		// `remove(index)` is HTMLSelectElement's option removal, not the node's own.
		if (name === 'remove') return call.arguments.length === 0 && isTarget(callee.object);
		return name === 'removeChild' && isTarget(call.arguments[0]);
	};

	/**
	 * Whether every pass of a loop with this `body` removes a node `isTarget`
	 * accepts. The removal must be one of the body's own statements (or an
	 * arrow callback's expression body), and nothing in the body may leave a
	 * pass early: a removal behind an `if`, a ternary, `&&`, a `try`, or after a
	 * `continue` / `break` / `return` / `throw` may skip children, so the rest of
	 * the document can survive and the loop is not reported.
	 */
	const removesEveryPass = (body: Node, isTarget: (candidate: Node) => boolean) => {
		if (!body || containsNode(body, (candidate) => EARLY_EXITS.has(candidate.type))) return false;
		const statements: Node[] = body.type === 'BlockStatement' ? body.body : [body];
		return statements.some((statement) =>
			isRemovalOf(
				statement?.type === 'ExpressionStatement' ? statement.expression : statement,
				isTarget
			)
		);
	};

	/** Whether `body` writes `variable` again, so a later read may no longer be the loop's node. */
	const rewrites = (body: Node, variable: Variable) => {
		if (!body) return false;
		const [start, end] = body.range;
		return variable.references.some((reference) => {
			const [at] = reference.identifier.range;
			return reference.isWrite() && at >= start && at < end;
		});
	};

	/** Whether every pass of a loop with this `body` removes the node it binds to `binding`. */
	const removesVisited = (body: Node, binding: Node) => {
		const variable = binding?.type === 'Identifier' ? localVariable(binding) : undefined;
		return (
			variable !== undefined &&
			!rewrites(body, variable) &&
			removesEveryPass(body, (candidate) => isVariable(candidate, variable))
		);
	};

	/** `<root>.childElementCount`, `<root>.children.length` or `<root>.childNodes.length`. */
	const isChildCount = (node: Node) => {
		const current = unwrap(node);
		if (current?.type !== 'MemberExpression') return false;
		if (isRootMember(current, CHILD_COUNTS)) return true;
		const collection = unwrap(current.object);
		return (
			propertyName(current) === 'length' &&
			collection !== undefined &&
			collection !== null &&
			isRootMember(collection, CHILD_COLLECTIONS)
		);
	};

	const isLiteral = (node: Node, value: unknown) => {
		const current = unwrap(node);
		return (
			(current?.type === 'Literal' && current.value === value) ||
			(value === undefined &&
				current?.type === 'Identifier' &&
				current.name === 'undefined' &&
				!localVariable(current))
		);
	};

	/**
	 * Whether a loop `test` holds exactly while the root has any child, so the
	 * loop runs until the root is empty: a child read (`<root>.firstChild`,
	 * `(node = <root>.firstChild)`), `<root>.hasChildNodes()`, a child count, or
	 * one of those compared against "none" (`count > 0`, `count !== 0`,
	 * `count >= 1`, `child !== null`). Any other bound (`count > 1`) or a
	 * compound test may stop with children left, so it does not count. A
	 * variable the test assigns a child to is collected into `assigned`.
	 */
	const testsNonEmpty = (node: Node, assigned: Variable[]): boolean => {
		const current = unwrap(node);
		if (!current) return false;
		if (isRootChild(current) || isChildCount(current)) return true;
		switch (current.type) {
			case 'AssignmentExpression': {
				const variable =
					current.operator === '=' && current.left.type === 'Identifier'
						? localVariable(current.left)
						: undefined;
				if (!variable || !isRootChild(current.right)) return false;
				assigned.push(variable);
				return true;
			}
			case 'CallExpression': {
				const callee = unwrap(current.callee);
				return (
					current.arguments.length === 0 &&
					callee !== undefined &&
					callee !== null &&
					isRootMember(callee, HAS_CHILDREN)
				);
			}
			case 'UnaryExpression': {
				const inner = unwrap(current.argument);
				return (
					current.operator === '!' &&
					inner?.type === 'UnaryExpression' &&
					inner.operator === '!' &&
					testsNonEmpty(inner.argument, assigned)
				);
			}
			case 'BinaryExpression': {
				const { left, right } = current;
				if (left.type === 'PrivateIdentifier') return false;
				const mirrored = MIRRORED_OPERATORS[current.operator] ?? current.operator;
				for (const [subject, bound, operator] of [
					[left, right, current.operator],
					[right, left, mirrored],
				] as const) {
					if (isChildCount(subject)) {
						if (NOT_EQUAL.has(operator) || operator === '>') {
							if (isLiteral(bound, 0)) return true;
						} else if (operator === '>=' && isLiteral(bound, 1)) return true;
					} else if (
						NOT_EQUAL.has(operator) &&
						(isLiteral(bound, null) || (operator === '!==' && isLiteral(bound, undefined))) &&
						(isRootChild(subject) || unwrap(subject)?.type === 'AssignmentExpression') &&
						testsNonEmpty(subject, assigned)
					) {
						return true;
					}
				}
				return false;
			}
			default:
				return false;
		}
	};

	/**
	 * Whether a `while` / `do` / `for` loop drains the root: its test holds
	 * until the root is empty and every pass removes one of the root's children,
	 * read straight off the root or through a variable the test assigns one to
	 * (`while ((node = document.body.firstChild)) node.remove()`).
	 */
	const drainsRoot = (test: Node, body: Node) => {
		const assigned: Variable[] = [];
		if (!testsNonEmpty(test, assigned)) return false;
		if (assigned.some((variable) => rewrites(body, variable))) return false;
		return removesEveryPass(
			body,
			(candidate) =>
				isRootChild(candidate) || assigned.some((variable) => isVariable(candidate, variable))
		);
	};

	/** Whether `node` is the global `Array`, not a local binding of that name. */
	const isGlobalArray = (node: Node) => {
		const current = unwrap(node);
		return current?.type === 'Identifier' && current.name === 'Array' && !localVariable(current);
	};

	/**
	 * Whether iterating `node` visits every child of the root: `<root>.children`
	 * or `.childNodes`, `<root>.querySelectorAll('*')` / `getElementsByTagName('*')`,
	 * or a plain copy of one (`[...x]`, also with extra elements, `Array.from(x)`
	 * without a mapper, `x.slice()`), directly or through a never-reassigned
	 * alias. Only the iterable's own value counts: a collection read off one
	 * child (`<root>.children[0].children`), a filtered or mapped copy, or any
	 * other expression that merely mentions the root's children visits a subset
	 * or other nodes and leaves the document in place.
	 */
	const walksRootChildren = (node: Node, depth = 0): boolean => {
		const current = unwrap(node);
		if (!current || depth > 8) return false;
		switch (current.type) {
			case 'Identifier': {
				const alias = aliasOf(current);
				return alias !== undefined && 'value' in alias && walksRootChildren(alias.value, depth + 1);
			}
			case 'MemberExpression':
				return isRootMember(current, CHILD_COLLECTIONS);
			case 'ArrayExpression':
				return current.elements.some(
					(element) =>
						element?.type === 'SpreadElement' && walksRootChildren(element.argument, depth + 1)
				);
			case 'CallExpression': {
				const callee = unwrap(current.callee);
				if (callee?.type !== 'MemberExpression') return false;
				const name = propertyName(callee);
				const args = current.arguments;
				if (isRootMember(callee, WILDCARD_QUERIES)) {
					const [selector] = args;
					return selector?.type === 'Literal' && selector.value === '*';
				}
				if (name === 'from' && isGlobalArray(callee.object)) {
					return args.length === 1 && walksRootChildren(args[0], depth + 1);
				}
				return name === 'slice' && args.length === 0 && walksRootChildren(callee.object, depth + 1);
			}
			default:
				return false;
		}
	};

	return { drainsRoot, removesVisited, walksRootChildren };
};
