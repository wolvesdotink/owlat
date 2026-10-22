import { createRootMatcher, type Node, propertyName, unwrap } from '../documentRoot.ts';
import { createLoopMatcher } from '../documentRootLoops.ts';
import { matchesAnyGlob } from '../fileGlobs.ts';
import type { AstNode, Rule } from '../types.ts';

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
 *    children (or its `'*'` descendants, or a plain copy of either) that
 *    removes the node it is visiting.
 * A loop only counts when it removes every one of the root's own children:
 * each pass removes them (`.remove()` on them or `.removeChild(…)` with them
 * as the argument) as one of the loop body's own statements, nothing in the
 * body can end a pass early, and a draining loop runs until the root is empty
 * (`count > 0`, not `count > 1`). Removing a node found inside a child, some
 * unrelated node, the members of a filtered or mapped copy or of one child's
 * own children, only the children a condition picks, or children down to a
 * bound above zero, leaves the rest of the document in place and stays
 * allowed.
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

const CONTENT_PROPERTIES = new Set(['innerHTML', 'outerHTML', 'textContent', 'innerText']);
const REPLACING_METHODS = new Set(['replaceChildren', 'replaceWith', 'setHTML', 'setHTMLUnsafe']);

const MESSAGE =
	'Do not reset the whole document in a test: it hides components a test left mounted. The shared vitest setup unmounts every mount after each test; append hand-built DOM to a node you own and remove that node.';

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
		const root = createRootMatcher(context);
		const { isRootElement, isRootMember } = root;
		const { drainsRoot, removesVisited, walksRootChildren } = createLoopMatcher(root);
		const report = (node: AstNode) => context.report({ node, message: MESSAGE });

		/** A loop that keeps removing the body's children until it has none. */
		const checkDrainingLoop = (node: AstNode) => {
			if (!('test' in node) || !('body' in node)) return;
			if (drainsRoot(node.test as Node, node.body as Node)) report(node);
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
