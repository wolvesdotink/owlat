import type { AstNode, Context, Rule } from '../types.ts';
import {
	importedName,
	type Node,
	propertyName,
	resolveVariable,
	unwrap,
	vitestExport,
	declarationOf,
} from '../vitestApi.ts';

/**
 * A test gets its time budget from its package's vitest config, or from a
 * shared constant in the root `vitest.timeouts.ts`; it is never retried; and a
 * test that is switched off says which issue tracks it.
 *
 * - Timeouts: a per-test or per-hook timeout (`it(name, fn, 30_000)`,
 *   `{ timeout }` options on a test or suite, `beforeAll(fn, 30_000)`,
 *   `vi.setConfig({ testTimeout })`) must name a constant imported from
 *   `vitest.timeouts.ts`, directly or through a local `const` alias. A local
 *   number hides a wait that should await its milestone, and every suite
 *   inventing its own budget is how a release gate ends up failing on machine
 *   load.
 * - Retries: a `retry` option on a test, suite or `vi.setConfig`, and any
 *   `retry` key in a vitest config file, is reported whatever its value. A retried flake still fails at its own rate on every
 *   run that does not retry it, and the retry hides that rate.
 * - Skips: `.skip` / `.todo` (as a modifier or a `{ skip: true }` option) and a
 *   `skipIf` / `runIf` whose condition is a literal need a tracking issue in
 *   the comment directly above the statement: `// quarantine: #1234 <why>`.
 *   `skipIf` / `runIf` (and `{ skip: <expression> }`) with a real condition are
 *   environment gates and stay allowed.
 *
 * Only calls bound to vitest's own imports count, so `vi.waitFor(fn, { timeout })`,
 * a subprocess `timeout` and an unrelated `test()` helper are never reported.
 */

const HOOKS = new Set([
	'beforeAll',
	'beforeEach',
	'afterAll',
	'afterEach',
	'aroundAll',
	'aroundEach',
]);
const SET_CONFIG_TIMEOUTS = new Set(['testTimeout', 'hookTimeout']);
const SKIP_MODIFIERS = new Set(['skip', 'todo']);
const VITEST_CONFIG_FILE =
	/(?:^|[\\/])vitest\.(?:config|shared|workspace)(?:\.[\w-]+)?\.[cm]?[jt]s$/;
const SHARED_TIMEOUTS_MODULE = /(?:^|\/)vitest\.timeouts(?:\.[cm]?[jt]s)?$/;
const QUARANTINE = /^\s*quarantine:\s*#\d+\s+\S/;
const MAX_ALIAS_DEPTH = 4;
const FUNCTION_EXPRESSIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression']);

const TIMEOUT_MESSAGE =
	'Use a shared budget from vitest.timeouts.ts (or the project testTimeout) instead of a local timeout. A slow test awaits its milestone; it does not get its own number.';
const RETRY_MESSAGE =
	'Tests are not retried. Fix the flake, or skip the test with `// quarantine: #<issue> <why>` on the line above.';
const SKIP_MESSAGE =
	'A skipped or todo test needs its tracking issue in the comment directly above: `// quarantine: #<issue> <why>`. Gate on the environment with skipIf/runIf instead.';

const isSharedTimeoutsModule = (specifier: string) => SHARED_TIMEOUTS_MODULE.test(specifier);

/** Whether a timeout value is a constant from `vitest.timeouts.ts`, or a `const` alias of one. */
const isSharedBudget = (context: Context, value: Node, depth = 0): boolean => {
	const node = unwrap(value);
	if (node?.type === 'MemberExpression') {
		return (
			propertyName(node) !== undefined &&
			importedName(context, unwrap(node.object), isSharedTimeoutsModule) === 'namespace'
		);
	}
	if (node?.type !== 'Identifier') return false;
	const imported = importedName(context, node, isSharedTimeoutsModule);
	if (imported !== undefined) return imported !== 'namespace';
	if (depth >= MAX_ALIAS_DEPTH) return false;
	const definition = resolveVariable(context, node)?.defs[0];
	if (
		definition?.type !== 'Variable' ||
		definition.parent?.type !== 'VariableDeclaration' ||
		definition.parent.kind !== 'const' ||
		definition.node.type !== 'VariableDeclarator' ||
		definition.node.id.type !== 'Identifier'
	) {
		return false;
	}
	return isSharedBudget(context, definition.node.init, depth + 1);
};

/** The statement a call sits in, which a quarantine comment must precede. */
const enclosingStatement = (node: AstNode): AstNode => {
	let current: AstNode = node;
	while (current.parent && !/(?:Statement|Declaration)$/.test(current.type)) {
		current = current.parent;
	}
	return current;
};

/** A property's static key (`timeout`, `'timeout'`, `['timeout']`), if it has one. */
const propertyKey = (property: AstNode): string | undefined => {
	if (property.type !== 'Property') return undefined;
	const { key } = property;
	if (!property.computed && key.type === 'Identifier') return key.name;
	return key.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined;
};

const objectProperties = (node: Node) => {
	const object = unwrap(node);
	if (object?.type !== 'ObjectExpression') return [];
	return object.properties.flatMap((property) => {
		const key = propertyKey(property);
		return key === undefined || property.type !== 'Property'
			? []
			: [{ key, property, value: property.value }];
	});
};

const isLiteral = (node: Node, test: (value: unknown) => boolean) => {
	const literal = unwrap(node);
	return literal?.type === 'Literal' && test(literal.value);
};

const rule: Rule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Disallow local per-test timeouts and retries, and require a tracking issue for an unconditional skip or todo.',
		},
	},
	create(context) {
		if (!context.sourceCode.text.includes('vitest')) return {};

		const checkTimeout = (value: Node) => {
			if (value && !isSharedBudget(context, value)) {
				context.report({ node: value, message: TIMEOUT_MESSAGE });
			}
		};

		const reportUnlessQuarantined = (call: AstNode, node: AstNode) => {
			const comments = context.sourceCode.getCommentsBefore(enclosingStatement(call));
			if (comments.some((comment) => QUARANTINE.test(comment.value))) return;
			context.report({ node, message: SKIP_MESSAGE });
		};

		/** A test or suite options object: its timeout, retry and literal skip/todo. */
		const checkOptions = (call: AstNode, options: Node) => {
			for (const { key, property, value } of objectProperties(options)) {
				if (key === 'timeout') checkTimeout(value);
				else if (key === 'retry') context.report({ node: property, message: RETRY_MESSAGE });
				else if (SKIP_MODIFIERS.has(key) && isLiteral(value, (v) => v === true)) {
					reportUnlessQuarantined(call, property);
				}
			}
		};

		return {
			// In a vitest config file a `retry` key means nothing but test retries.
			...(VITEST_CONFIG_FILE.test(context.filename) && {
				Property(node: AstNode) {
					if (node.parent?.type === 'ObjectExpression' && propertyKey(node) === 'retry') {
						context.report({ node, message: RETRY_MESSAGE });
					}
				},
			}),
			CallExpression(node) {
				const callee = unwrap(node.callee);
				const args = node.arguments as AstNode[];

				const calleeName = vitestExport(context, callee);
				if (calleeName !== undefined && HOOKS.has(calleeName)) {
					checkTimeout(args[1]);
					return;
				}

				if (
					propertyName(callee) === 'setConfig' &&
					callee?.type === 'MemberExpression' &&
					['vi', 'vitest'].includes(vitestExport(context, callee.object) ?? '')
				) {
					for (const { key, property, value } of objectProperties(args[0])) {
						if (SET_CONFIG_TIMEOUTS.has(key)) checkTimeout(value);
						else if (key === 'retry') context.report({ node: property, message: RETRY_MESSAGE });
					}
					return;
				}

				const declaration = declarationOf(context, callee);
				if (!declaration) return;

				for (const modifier of declaration.modifiers) {
					if (SKIP_MODIFIERS.has(modifier.name)) reportUnlessQuarantined(node, modifier.node);
				}
				for (const factory of declaration.factories) {
					const [condition] = factory.args;
					const alwaysOff =
						(factory.name === 'skipIf' && isLiteral(condition, (v) => Boolean(v))) ||
						(factory.name === 'runIf' && isLiteral(condition, (v) => !v));
					if (alwaysOff) reportUnlessQuarantined(node, factory.node);
				}

				// `it(name, options, fn)`, or `it(name, fn, timeout)` and the older
				// `it(name, fn, options)`.
				const [, second, third] = args;
				if (unwrap(second)?.type === 'ObjectExpression') checkOptions(node, second);
				else if (unwrap(third)?.type === 'ObjectExpression') checkOptions(node, third);
				else if (third && !FUNCTION_EXPRESSIONS.has(unwrap(third)?.type ?? '')) {
					checkTimeout(third);
				}
			},
		};
	},
};

export default rule;
