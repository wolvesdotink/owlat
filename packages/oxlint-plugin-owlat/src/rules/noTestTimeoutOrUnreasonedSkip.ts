import type { AstNode, Context, Rule } from '../types.ts';
import {
	declarationOf,
	importedName,
	type Node,
	propertyName,
	resolveVariable,
	unwrap,
	vitestExport,
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
 *   `retry` key in a vitest config file (imported from vitest or not), is
 *   reported whatever its value. A retried flake still fails at its own rate
 *   on every run that does not retry it, and the retry hides that rate.
 * - Skips: `.skip` / `.todo` (as a modifier or a `{ skip: true }` option) and a
 *   `skipIf` / `runIf` whose condition is a literal need a tracking issue in
 *   the comment block directly above the statement, with no blank line in
 *   between: `// quarantine: #1234 <why>`. `skipIf` / `runIf` (and
 *   `{ skip: <expression> }`) with a real condition are environment gates and
 *   stay allowed.
 *
 * Options and timeouts are read through `const` aliases and object spreads, so
 * `const opts = { retry: 1 }; it(name, opts, fn)` counts like inline options.
 * A third argument that is not an options object or a function is taken as a
 * timeout, so an imported test function after imported options is reported;
 * pass the function inline or declare it in the file.
 *
 * Only calls bound to vitest's own imports count, so `vi.waitFor(fn, { timeout })`,
 * a subprocess `timeout` and an unrelated `test()` helper are never reported.
 * The rule runs on every linted file, so a call is resolved against scope only
 * when the name its callee chain starts from was imported from vitest as a
 * test, suite, hook or `vi`; everything else is dismissed by that name alone.
 */

const HOOKS = new Set([
	'beforeAll',
	'beforeEach',
	'afterAll',
	'afterEach',
	'aroundAll',
	'aroundEach',
]);
const VI = new Set(['vi', 'vitest']);
/** The vitest exports a call this rule checks can start from. */
const CHAIN_ROOTS = new Set(['it', 'test', 'describe', 'suite', ...HOOKS, ...VI, 'namespace']);
const SET_CONFIG_TIMEOUTS = new Set(['testTimeout', 'hookTimeout']);
const SKIP_MODIFIERS = new Set(['skip', 'todo']);
const VITEST_CONFIG_FILE =
	/(?:^|[\\/])vitest\.(?:config|shared|workspace)(?:\.[\w-]+)?\.[cm]?[jt]s$/;
const SHARED_TIMEOUTS_MODULE = /(?:^|\/)vitest\.timeouts(?:\.[cm]?[jt]s)?$/;
const QUARANTINE = /^\s*quarantine:\s*#\d+\s+\S/;
const MAX_ALIAS_DEPTH = 4;
const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration']);

const TIMEOUT_MESSAGE =
	'Use a shared budget from vitest.timeouts.ts (or the project testTimeout) instead of a local timeout. A slow test awaits its milestone; it does not get its own number.';
const RETRY_MESSAGE =
	'Tests are not retried. Fix the flake, or skip the test with `// quarantine: #<issue> <why>` on the line above.';
const SKIP_MESSAGE =
	'A skipped or todo test needs its tracking issue in the comment directly above: `// quarantine: #<issue> <why>`. Gate on the environment with skipIf/runIf instead.';

const isSharedTimeoutsModule = (specifier: string) => SHARED_TIMEOUTS_MODULE.test(specifier);

/**
 * What an identifier is bound to when that binding cannot change: the
 * initializer of a plain `const name = …`, or a function declaration. Anything
 * else (a `let`, a parameter, an import, a destructured name) is undefined.
 */
const constBinding = (context: Context, identifier: Node): Node => {
	const definition = resolveVariable(context, identifier)?.defs[0];
	if (definition?.type === 'FunctionName') return definition.node as AstNode;
	if (
		definition?.type !== 'Variable' ||
		definition.parent?.type !== 'VariableDeclaration' ||
		definition.parent.kind !== 'const' ||
		definition.node.type !== 'VariableDeclarator' ||
		definition.node.id.type !== 'Identifier'
	) {
		return undefined;
	}
	return definition.node.init;
};

/**
 * The value an argument stands for, following `const` aliases
 * (`const opts = { retry: 1 }; it(name, opts, fn)`) to their initializer. An
 * identifier that resolves no further is returned as is.
 */
const resolveValue = (context: Context, value: Node): Node => {
	let node = unwrap(value);
	for (let depth = 0; depth < MAX_ALIAS_DEPTH && node?.type === 'Identifier'; depth += 1) {
		const bound = unwrap(constBinding(context, node));
		if (!bound) break;
		node = bound;
	}
	return node;
};

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
	return isSharedBudget(context, constBinding(context, node), depth + 1);
};

/** The identifier a callee chain (`it.skip.each(cases)`, `vitest.it`) starts from. */
const chainRoot = (node: Node): string | undefined => {
	let current = unwrap(node);
	for (;;) {
		if (current?.type === 'Identifier') return current.name;
		if (current?.type === 'MemberExpression') current = unwrap(current.object);
		else if (current?.type === 'CallExpression') current = unwrap(current.callee);
		else if (current?.type === 'TaggedTemplateExpression') current = unwrap(current.tag);
		else return undefined;
	}
};

/** The statement a call sits in, whose comment block must hold the quarantine. */
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

interface OptionProperty {
	readonly key: string;
	readonly property: AstNode;
	readonly value: Node;
}

/**
 * The statically keyed properties of an options object, through `const`
 * aliases and spreads of them (`{ ...base, timeout }`), so options kept in a
 * variable are checked like options written inline.
 */
const objectProperties = (context: Context, node: Node, depth = 0): OptionProperty[] => {
	const object = resolveValue(context, node);
	if (object?.type !== 'ObjectExpression' || depth > MAX_ALIAS_DEPTH) return [];
	return object.properties.flatMap((property): OptionProperty[] => {
		if (property.type === 'SpreadElement') {
			return objectProperties(context, property.argument, depth + 1);
		}
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
		// A vitest config file is checked whatever it imports: a plain
		// `export default { test: { retry: 1 } }` configures vitest too. Any
		// other file can only reach vitest's API through an import naming it.
		const isConfigFile = VITEST_CONFIG_FILE.test(context.filename);
		if (!isConfigFile && !context.sourceCode.text.includes('vitest')) return {};

		/** Local names bound by `import … from 'vitest'`, to what they import. */
		const vitestLocals = new Map<string, string>();

		const checkTimeout = (value: Node) => {
			if (value && !isSharedBudget(context, value)) {
				context.report({ node: value, message: TIMEOUT_MESSAGE });
			}
		};

		/**
		 * The comment block directly above a statement: the comments before it
		 * that each end on the line before the next one starts, the last on the
		 * line before the statement. A blank line or code ends the block, so a
		 * quarantine note further up belongs to something else.
		 */
		const adjacentComments = (statement: AstNode) => {
			const comments = context.sourceCode.getCommentsBefore(statement);
			const block = [];
			let nextLine = statement.loc.start.line;
			for (let index = comments.length - 1; index >= 0; index -= 1) {
				const comment = comments[index]!;
				if (comment.loc.end.line !== nextLine - 1) break;
				block.push(comment);
				nextLine = comment.loc.start.line;
			}
			return block;
		};

		const reportUnlessQuarantined = (call: AstNode, node: AstNode) => {
			const comments = adjacentComments(enclosingStatement(call));
			if (comments.some((comment) => QUARANTINE.test(comment.value))) return;
			context.report({ node, message: SKIP_MESSAGE });
		};

		/** A test or suite options object: its timeout, retry and literal skip/todo. */
		const checkOptions = (call: AstNode, options: Node) => {
			for (const { key, property, value } of objectProperties(context, options)) {
				if (key === 'timeout') checkTimeout(value);
				else if (key === 'retry') context.report({ node: property, message: RETRY_MESSAGE });
				else if (SKIP_MODIFIERS.has(key) && isLiteral(value, (v) => v === true)) {
					reportUnlessQuarantined(call, property);
				}
			}
		};

		return {
			// In a vitest config file a `retry` key means nothing but test retries.
			...(isConfigFile && {
				Property(node: AstNode) {
					if (node.parent?.type === 'ObjectExpression' && propertyKey(node) === 'retry') {
						context.report({ node, message: RETRY_MESSAGE });
					}
				},
			}),
			ImportDeclaration(node) {
				if (node.source.value !== 'vitest') return;
				for (const specifier of node.specifiers) {
					const imported =
						specifier.type === 'ImportSpecifier'
							? specifier.imported.type === 'Identifier'
								? specifier.imported.name
								: String(specifier.imported.value)
							: specifier.type === 'ImportNamespaceSpecifier'
								? 'namespace'
								: 'default';
					vitestLocals.set(specifier.local.name, imported);
				}
			},
			CallExpression(node) {
				const callee = unwrap(node.callee);
				const root = chainRoot(callee);
				if (root === undefined || !CHAIN_ROOTS.has(vitestLocals.get(root) ?? '')) return;
				const args = node.arguments as AstNode[];

				const calleeName = vitestExport(context, callee);
				if (calleeName !== undefined && HOOKS.has(calleeName)) {
					checkTimeout(args[1]);
					return;
				}

				if (
					propertyName(callee) === 'setConfig' &&
					callee?.type === 'MemberExpression' &&
					VI.has(vitestExport(context, callee.object) ?? '')
				) {
					for (const { key, property, value } of objectProperties(context, args[0])) {
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
				// `it(name, fn, options)`. Arguments are read through `const`
				// aliases, so a third argument that is the test function itself
				// (inline or named) is never taken for a timeout.
				const [, second, third] = args;
				const secondValue = resolveValue(context, second);
				const thirdValue = resolveValue(context, third);
				if (secondValue?.type === 'ObjectExpression') checkOptions(node, second);
				else if (thirdValue?.type === 'ObjectExpression') checkOptions(node, third);
				else if (third && !FUNCTIONS.has(thirdValue?.type ?? '')) checkTimeout(third);
			},
		};
	},
};

export default rule;
