import type { AstNode, Rule } from '../types.ts';
import { declarationOf, type Node } from '../vitestApi.ts';

/**
 * Tests and suites are declared with `.each`, never inside a loop. A loop hides
 * the case list inside control flow and builds each title in the loop body,
 * where it drifts silently when the loop changes. `it.each(cases)(title, fn)`
 * keeps the cases as data under one title template, the form the rest of the
 * suites already use.
 *
 * Only calls that resolve to vitest's own `it` / `test` / `describe` / `suite`
 * import count (with their `.only` / `.skip` / `.concurrent` / … modifiers, the
 * curried `.each(…)(…)` / `.for(…)(…)` / `.skipIf(…)(…)` / `.extend(…)(…)`
 * forms and tagged-template `.each` tables, chained in any order), so an
 * unrelated function that happens to be called `test` is never flagged. A loop
 * inside a test body is fine: a function boundary between the call and the loop
 * ends the search.
 *
 * The rule runs on every linted file, so it does the cheap checks first: a file
 * that never names vitest is skipped, and a call is resolved against scope (the
 * expensive part) only once it is known to sit inside a loop.
 */

const LOOPS = new Set([
	'ForStatement',
	'ForInStatement',
	'ForOfStatement',
	'WhileStatement',
	'DoWhileStatement',
]);
const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration']);

const insideLoop = (node: AstNode): boolean => {
	let current: Node = node.parent;
	while (current) {
		if (LOOPS.has(current.type)) return true;
		if (FUNCTIONS.has(current.type)) return false;
		current = current.parent;
	}
	return false;
};

const rule: Rule = {
	meta: {
		type: 'suggestion',
		docs: {
			description:
				'Disallow declaring tests or suites inside a loop; use it.each / describe.each instead.',
		},
	},
	create(context) {
		if (!context.sourceCode.text.includes('vitest')) return {};
		return {
			CallExpression(node) {
				if (!insideLoop(node)) return;
				const name = declarationOf(context, node.callee)?.root;
				if (name === undefined) return;
				context.report({
					node: node.callee,
					message: `Do not declare ${name}(…) inside a loop. Use ${name}.each(cases)(title, …) so every case has a stable, filterable name.`,
				});
			},
		};
	},
};

export default rule;
