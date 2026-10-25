/**
 * How long each Convex function handler is: the census behind
 * `check-handler-size.sh`.
 *
 * A handler that loads, decides and writes in one body grows with every rule
 * added to it, and its decisions can only be tested through the database. The
 * cure is a pure decision core beside it (see "Decision cores" in
 * `convex/CONVENTIONS.md`); this census measures how far the longest handlers
 * still are from that.
 *
 * What counts as a handler, read from the syntax tree:
 *
 *   - a module-level `const <name> = <builder>(…)` whose builder is a Convex
 *     registration: `query`, `mutation`, `action`, `httpAction`, their
 *     `internal…` forms, and every composed `…Query` / `…Mutation` /
 *     `…Action` builder (`authedQuery`, `postboxMutation`, …);
 *   - the handler is the `handler` property of the definition object (a
 *     function literal, a method, or the name of a function in the module),
 *     or the function literal handed to the builder directly
 *     (`httpAction(async (ctx, request) => …)`).
 *
 * The length is the handler function's own span: the line its first token sits
 * on through the line of its closing token, inclusive, comments and blank lines
 * included (a comment block inside a handler is part of what a reader has to
 * get through). A handler bound by name is measured where that function is
 * declared.
 */
import ts from 'typescript';
import { isFunctionLiteral, resolveFunction, type FunctionLike } from './functionBindings';

/** One registered Convex function and the length of its handler. */
export interface HandlerSize {
	/** Module path as the census was given it (`convex/campaigns/send.ts`). */
	readonly module: string;
	/** The module-level name the function is bound to. */
	readonly name: string;
	readonly lines: number;
}

const CONVEX_BUILDER =
	/^(?:query|mutation|action|httpAction|internal(?:Query|Mutation|Action)|[A-Za-z0-9_$]*(?:Query|Mutation|Action))$/;

function handlerOf(init: ts.Expression | undefined): FunctionLike | undefined {
	if (!init || !ts.isCallExpression(init)) return undefined;
	const callee = init.expression;
	if (!ts.isIdentifier(callee) || !CONVEX_BUILDER.test(callee.text)) return undefined;
	const [definition] = init.arguments;
	if (!definition) return undefined;
	if (isFunctionLiteral(definition)) return definition;
	if (!ts.isObjectLiteralExpression(definition)) return undefined;
	for (const property of definition.properties) {
		if (!property.name || !ts.isIdentifier(property.name)) continue;
		if (property.name.text !== 'handler') continue;
		if (ts.isMethodDeclaration(property)) return property;
		if (ts.isPropertyAssignment(property)) {
			const value = property.initializer;
			if (isFunctionLiteral(value)) return value;
			if (ts.isIdentifier(value)) return resolveFunction(value);
		}
		if (ts.isShorthandPropertyAssignment(property)) return resolveFunction(property.name);
	}
	return undefined;
}

function spanLines(sourceFile: ts.SourceFile, fn: FunctionLike): number {
	const first = sourceFile.getLineAndCharacterOfPosition(fn.getStart(sourceFile)).line;
	const last = sourceFile.getLineAndCharacterOfPosition(fn.getEnd()).line;
	return last - first + 1;
}

/** Every registered handler in one module, in source order. */
export function censusModule(module: string, source: string): HandlerSize[] {
	const sourceFile = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
	const found: HandlerSize[] = [];
	for (const statement of sourceFile.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name)) continue;
			const handler = handlerOf(declaration.initializer);
			if (!handler) continue;
			found.push({ module, name: declaration.name.text, lines: spanLines(sourceFile, handler) });
		}
	}
	return found;
}

/**
 * Longest first; equal lengths in `module:name` order, so the listing is the
 * same on every machine.
 */
export function byLength(handlers: readonly HandlerSize[]): HandlerSize[] {
	return [...handlers].sort((a, b) => {
		if (a.lines !== b.lines) return b.lines - a.lines;
		const left = `${a.module}:${a.name}`;
		const right = `${b.module}:${b.name}`;
		return left < right ? -1 : left > right ? 1 : 0;
	});
}

/** The ratchet entries: `<module>:<name> <lines>` for each handler over `cap`. */
export function censusLines(handlers: readonly HandlerSize[], cap: number): string[] {
	return byLength(handlers)
		.filter((handler) => handler.lines > cap)
		.map((handler) => `${handler.module}:${handler.name} ${handler.lines}`);
}
