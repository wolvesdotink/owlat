import {
	type ChildKind,
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

/** Counts of the root's children a draining loop tests, of the kind each counts. */
const CHILD_COUNTS = new Map<string, ChildKind>([['childElementCount', 'element']]);
/** The call that tells a draining loop whether the root still has child nodes. */
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
	endChildKind,
	isRootMember,
	isVariable,
	localVariable,
	aliasOf,
	rootCollectionKind,
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

	/**
	 * The kind of child `node` counts if it is `<root>.childElementCount`,
	 * `<root>.children.length` or `<root>.childNodes.length`.
	 */
	const childCountKind = (node: Node): ChildKind | undefined => {
		const current = unwrap(node);
		if (current?.type !== 'MemberExpression') return undefined;
		const name = propertyName(current);
		if (name !== undefined && isRootMember(current, CHILD_COUNTS)) return CHILD_COUNTS.get(name);
		return name === 'length' ? rootCollectionKind(current.object) : undefined;
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
	 * The kind of child a loop `test` probes if it holds exactly while the root
	 * has any child of that kind, so the loop runs until none are left: an end
	 * child read (`<root>.firstChild`, `<root>.children[0]`,
	 * `(node = <root>.firstChild)`), `<root>.hasChildNodes()`, a child count, or
	 * one of those compared against "none" (`count > 0`, `count !== 0`,
	 * `count >= 1`, `child !== null`). Any other bound (`count > 1`), a read of a
	 * later child (`children[1]`), a snapshot held in a variable, or a compound
	 * test may stop with children left, so it does not count. A variable the
	 * test assigns a child to is collected into `assigned`.
	 */
	const nonEmptyKind = (node: Node, assigned: Variable[]): ChildKind | undefined => {
		const current = unwrap(node);
		if (!current) return undefined;
		const probed = endChildKind(current) ?? childCountKind(current);
		if (probed) return probed;
		switch (current.type) {
			case 'AssignmentExpression': {
				const variable =
					current.operator === '=' && current.left.type === 'Identifier'
						? localVariable(current.left)
						: undefined;
				const kind = variable ? endChildKind(current.right) : undefined;
				if (variable && kind) assigned.push(variable);
				return kind;
			}
			case 'CallExpression': {
				const callee = unwrap(current.callee);
				return current.arguments.length === 0 &&
					callee !== undefined &&
					callee !== null &&
					isRootMember(callee, HAS_CHILDREN)
					? 'node'
					: undefined;
			}
			case 'UnaryExpression': {
				const inner = unwrap(current.argument);
				return current.operator === '!' &&
					inner?.type === 'UnaryExpression' &&
					inner.operator === '!'
					? nonEmptyKind(inner.argument, assigned)
					: undefined;
			}
			case 'BinaryExpression': {
				const { left, right } = current;
				if (left.type === 'PrivateIdentifier') return undefined;
				const mirrored = MIRRORED_OPERATORS[current.operator] ?? current.operator;
				for (const [subject, bound, operator] of [
					[left, right, current.operator],
					[right, left, mirrored],
				] as const) {
					const counted = childCountKind(subject);
					if (counted) {
						if ((NOT_EQUAL.has(operator) || operator === '>') && isLiteral(bound, 0))
							return counted;
						if (operator === '>=' && isLiteral(bound, 1)) return counted;
					} else if (
						NOT_EQUAL.has(operator) &&
						(isLiteral(bound, null) || (operator === '!==' && isLiteral(bound, undefined))) &&
						(endChildKind(subject) || unwrap(subject)?.type === 'AssignmentExpression')
					) {
						const kind = nonEmptyKind(subject, assigned);
						if (kind) return kind;
					}
				}
				return undefined;
			}
			default:
				return undefined;
		}
	};

	/**
	 * Whether a `while` / `do` / `for` loop drains the root: its test holds
	 * until the root has no child of the probed kind, and every pass removes one
	 * of the root's end children, read straight off the root, through a
	 * variable declared in the body, or through a variable the test assigns one
	 * to (`while ((node = document.body.firstChild)) node.remove()`). A loop that
	 * probes child nodes but removes elements stops (throws) once only text is
	 * left, so the removal must cover the probed kind.
	 */
	const drainsRoot = (test: Node, body: Node) => {
		const assigned: Variable[] = [];
		const probed = nonEmptyKind(test, assigned);
		if (!probed) return false;
		if (assigned.some((variable) => rewrites(body, variable))) return false;
		return removesEveryPass(body, (candidate) => {
			if (assigned.some((variable) => isVariable(candidate, variable))) return true;
			const removed = endChildKind(candidate, body);
			return removed === 'node' || removed === probed;
		});
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
				return rootCollectionKind(current) !== undefined;
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
