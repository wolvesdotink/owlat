/**
 * The global timer behind a `sleep` / `delay` helper a test imports from a
 * module of its own package, so a test that drives that timer with vitest's
 * fake timers is judged like one calling a helper declared in the same file.
 *
 * Only a relative import is followed, and only a helper of one shape is
 * accepted: an exported function declaration, or an exported `const` bound to
 * an arrow or function expression, whose name the module mentions nowhere
 * else (so no write can rebind it), and whose whole body returns
 * `new Promise(executor)`, where the executor's whole body is one global
 * `setTimeout` / `setInterval` call whose callback only resolves, with no
 * value or a primitive literal, so that one timer settles the promise and
 * nothing else can (resolving with a promise or a thenable adopts it, and the
 * wait then ends on that value's clock). The module may not bind
 * `setTimeout`, `setInterval` or `Promise` to anything else: every mention of
 * a timer has to be a call of it, and every mention of `Promise` a
 * `new Promise` or a type. Anything else (a package import, a re-export, a
 * `let` / `var` binding or a reassigned one, a helper that awaits more work, a
 * second timer, a branch, a callback that does more than resolve, a value
 * that is not a literal, a `node:timers` import) yields no timer, and the call
 * stays a real-clock wait.
 *
 * The module is parsed with the TypeScript compiler, loaded on first use: the
 * plugin API offers no parser for a second file, and most lint runs never
 * reach this.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type * as TypeScript from 'typescript';

type Ts = typeof TypeScript;

const GLOBAL_TIMERS = new Set(['setTimeout', 'setInterval']);
const SUFFIXES = ['', '.ts', '.mts', '.js', '.mjs', '/index.ts', '/index.js'];

let loaded: Ts | undefined;
const typescript = (): Ts => {
	loaded ??= createRequire(import.meta.url)('typescript') as Ts;
	return loaded;
};

/** Keyed by resolved path and export name; files do not change during a lint run. */
const timers = new Map<string, string | undefined>();

/** The files a relative specifier may name: as written, with an extension, or `.js` for `.ts`. */
const candidates = (filename: string, source: string): string[] => {
	const base = resolve(dirname(filename), source);
	const paths = SUFFIXES.map((suffix) => base + suffix);
	if (base.endsWith('.js')) paths.push(`${base.slice(0, -3)}.ts`);
	return paths;
};

const readable = (path: string): string | undefined => {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return undefined;
	}
};

const isExported = (ts: Ts, node: TypeScript.Node): boolean =>
	ts.canHaveModifiers(node) &&
	(ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

/**
 * Whether the module mentions `name` only once, in the declaration that binds
 * it. A function declaration's binding is writable and a later declaration of
 * the same name replaces it, so any second mention (a write, a redeclaration,
 * a re-export, a property of that name) leaves what the export finally holds
 * unknown.
 */
const mentionedOnce = (ts: Ts, file: TypeScript.SourceFile, name: string): boolean => {
	let mentions = 0;
	const visit = (node: TypeScript.Node): void => {
		if (mentions > 1) return;
		if (ts.isIdentifier(node)) {
			if (node.text === name) mentions += 1;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return mentions === 1;
};

/**
 * The function the module exports under `name` from its own declarations,
 * when nothing else in the module can rebind that export.
 */
const exportedFunction = (
	ts: Ts,
	file: TypeScript.SourceFile,
	name: string
): TypeScript.FunctionLikeDeclaration | undefined => {
	if (!mentionedOnce(ts, file, name)) return undefined;
	for (const statement of file.statements) {
		if (!isExported(ts, statement)) continue;
		if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
		if (!ts.isVariableStatement(statement)) continue;
		if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
		for (const declaration of statement.declarationList.declarations) {
			const init = declaration.initializer;
			if (
				ts.isIdentifier(declaration.name) &&
				declaration.name.text === name &&
				init &&
				(ts.isArrowFunction(init) || ts.isFunctionExpression(init))
			) {
				return init;
			}
		}
	}
	return undefined;
};

/** The one expression a function returns when that is its whole body. */
const returnedExpression = (
	ts: Ts,
	fn: TypeScript.FunctionLikeDeclaration
): TypeScript.Expression | undefined => {
	const body = fn.body;
	if (!body) return undefined;
	if (!ts.isBlock(body)) return body;
	const [only, ...rest] = body.statements;
	return rest.length === 0 && only && ts.isReturnStatement(only) ? only.expression : undefined;
};

const unwrapped = (ts: Ts, node: TypeScript.Expression): TypeScript.Expression =>
	ts.isParenthesizedExpression(node) ||
	ts.isAsExpression(node) ||
	ts.isSatisfiesExpression(node) ||
	ts.isNonNullExpression(node)
		? unwrapped(ts, node.expression)
		: node;

/**
 * Whether every mention of a timer in the module is a call of it and every
 * mention of `Promise` a `new Promise` or a type, so neither is rebound.
 */
const globalsUnbound = (ts: Ts, file: TypeScript.SourceFile): boolean => {
	let unbound = true;
	const visit = (node: TypeScript.Node): void => {
		if (!unbound) return;
		if (ts.isIdentifier(node)) {
			const { parent } = node;
			if (GLOBAL_TIMERS.has(node.text)) {
				unbound = ts.isCallExpression(parent) && parent.expression === node;
			} else if (node.text === 'Promise') {
				unbound =
					(ts.isNewExpression(parent) && parent.expression === node) ||
					ts.isTypeReferenceNode(parent);
			}
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return unbound;
};

/** Whether `node` writes a binding or a property, e.g. stores `resolve` and rebinds it. */
const writes = (ts: Ts, node: TypeScript.Node): boolean => {
	if (ts.isBinaryExpression(node)) {
		const operator = node.operatorToken.kind;
		return operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment;
	}
	if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
		return (
			node.operator === ts.SyntaxKind.PlusPlusToken ||
			node.operator === ts.SyntaxKind.MinusMinusToken
		);
	}
	return ts.isDeleteExpression(node);
};

/**
 * Whether `node` holds a call, a `new`, a function or a write, i.e. could
 * start or wait on more work, or hand the resolver to it.
 */
const doesWork = (ts: Ts, node: TypeScript.Node): boolean =>
	ts.isCallExpression(node) ||
	writes(ts, node) ||
	ts.isNewExpression(node) ||
	ts.isFunctionLike(node) ||
	ts.isAwaitExpression(node) ||
	ts.isYieldExpression(node) ||
	ts.isTaggedTemplateExpression(node) ||
	ts.forEachChild(node, (child) => doesWork(ts, child) || undefined) === true;

/** The one expression a function evaluates: its expression body, or a block of one expression statement. */
const onlyExpression = (
	ts: Ts,
	fn: TypeScript.FunctionLikeDeclaration
): TypeScript.Expression | undefined => {
	const body = fn.body;
	if (!body) return undefined;
	if (!ts.isBlock(body)) return unwrapped(ts, body);
	const [only, ...rest] = body.statements;
	return rest.length === 0 && only && ts.isExpressionStatement(only)
		? unwrapped(ts, only.expression)
		: undefined;
};

const firstParameter = (ts: Ts, fn: TypeScript.FunctionLikeDeclaration): string | undefined => {
	const [parameter] = fn.parameters;
	return parameter && ts.isIdentifier(parameter.name) ? parameter.name.text : undefined;
};

/**
 * Whether a value handed to `resolve` is a primitive literal. Resolving with a
 * promise or any thenable adopts it, so the promise settles when that value
 * does, on whatever clock it runs; a value not proven primitive (a binding, a
 * call, an object) may be one.
 */
const primitive = (ts: Ts, value: TypeScript.Expression): boolean => {
	const node = unwrapped(ts, value);
	return (
		ts.isNumericLiteral(node) ||
		ts.isBigIntLiteral(node) ||
		ts.isStringLiteral(node) ||
		ts.isNoSubstitutionTemplateLiteral(node) ||
		node.kind === ts.SyntaxKind.TrueKeyword ||
		node.kind === ts.SyntaxKind.FalseKeyword ||
		node.kind === ts.SyntaxKind.NullKeyword
	);
};

/**
 * Whether a timer callback does nothing but settle the promise with a
 * primitive: `resolve` itself, called with the timer's `passed` arguments, or
 * a function without parameters whose only work is `resolve(...)` with
 * primitive literals.
 */
const settlesOnly = (
	ts: Ts,
	callback: TypeScript.Expression,
	resolve: string,
	passed: readonly TypeScript.Expression[]
): boolean => {
	const node = unwrapped(ts, callback);
	if (ts.isIdentifier(node)) {
		return node.text === resolve && passed.every((argument) => primitive(ts, argument));
	}
	if (!(ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return false;
	if (node.parameters.length > 0) return false;
	const call = onlyExpression(ts, node);
	return (
		call !== undefined &&
		ts.isCallExpression(call) &&
		ts.isIdentifier(call.expression) &&
		call.expression.text === resolve &&
		call.arguments.every((argument) => primitive(ts, argument))
	);
};

/**
 * The global timer that alone settles an executor: its whole body is one call
 * of `setTimeout` / `setInterval` whose callback only resolves with a
 * primitive and whose other arguments do no work. Any second timer, branch,
 * statement, callback that does more or value that may be a thenable leaves
 * which clock settles the promise unknown, so it yields none: faking one timer
 * must be enough to drive the whole wait.
 */
const executorTimer = (ts: Ts, executor: TypeScript.Node): string | undefined => {
	if (!(ts.isArrowFunction(executor) || ts.isFunctionExpression(executor))) return undefined;
	const resolve = firstParameter(ts, executor);
	const call = onlyExpression(ts, executor);
	if (resolve === undefined || call === undefined || !ts.isCallExpression(call)) return undefined;
	if (!ts.isIdentifier(call.expression) || !GLOBAL_TIMERS.has(call.expression.text)) {
		return undefined;
	}
	// The timer hands the arguments after its delay to the callback.
	const [callback, ...rest] = call.arguments;
	if (!callback || !settlesOnly(ts, callback, resolve, rest.slice(1))) return undefined;
	return rest.some((argument) => doesWork(ts, argument)) ? undefined : call.expression.text;
};

const timerOf = (path: string, text: string, name: string): string | undefined => {
	const ts = typescript();
	const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
	if (!globalsUnbound(ts, file)) return undefined;
	const fn = exportedFunction(ts, file, name);
	const returned = fn && returnedExpression(ts, fn);
	if (!returned) return undefined;
	const promise = unwrapped(ts, returned);
	if (!ts.isNewExpression(promise) || !ts.isIdentifier(promise.expression)) return undefined;
	if (promise.expression.text !== 'Promise') return undefined;
	const [executor, ...extra] = promise.arguments ?? [];
	return executor && extra.length === 0 ? executorTimer(ts, unwrapped(ts, executor)) : undefined;
};

/**
 * The global timer behind the `name` export of the module `source` names,
 * imported by `filename`; undefined unless the helper has the shape above.
 */
export const importedSleepTimer = (
	filename: string,
	source: string,
	name: string
): string | undefined => {
	if (!source.startsWith('./') && !source.startsWith('../')) return undefined;
	for (const path of candidates(filename, source)) {
		const key = `${path}#${name}`;
		if (timers.has(key)) return timers.get(key);
		const text = readable(path);
		if (text === undefined) continue;
		const timer = timerOf(path, text, name);
		timers.set(key, timer);
		return timer;
	}
	return undefined;
};
