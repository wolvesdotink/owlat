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
 *   - the builder's argument is the definition object or the handler itself,
 *     written in place or named (`internalMutation(removeSendingDomain)`,
 *     `httpAction(run)`);
 *   - the handler is the `handler` property of the definition object: a
 *     function literal, a method, a named function, or a wrapper call around
 *     one (`deferredHandler(defer, async (ctx, args) => …)`, whose last
 *     argument is the handler).
 *
 * A name is followed to where it is declared: through aliases and through
 * named imports of relative modules (`handler: sendHandler` imported from
 * `./draftSend`), where the function is measured. A registration whose
 * handler cannot be found this way (a package import, a spread, a factory
 * call) is reported as a problem rather than skipped: a skipped handler could
 * grow past the cap without the ratchet seeing it.
 *
 * The length is the handler function's own span: the line its first token sits
 * on through the line of its closing token, inclusive, comments and blank lines
 * included (a comment block inside a handler is part of what a reader has to
 * get through).
 */
import ts from 'typescript';
import { isFunctionLiteral, resolveFunction, type FunctionLike } from './functionBindings';
import { resolveRelative } from './sourceGraph';

/** One registered Convex function and the length of its handler. */
export interface HandlerSize {
	/** Module path as the census was given it (`convex/campaigns/send.ts`). */
	readonly module: string;
	/** The module-level name the function is bound to. */
	readonly name: string;
	readonly lines: number;
}

/** One module's census: its handlers, and the registrations it could not measure. */
export interface ModuleCensus {
	/** Every registered handler in the module, in source order. */
	readonly handlers: HandlerSize[];
	/** `<module>:<line>: …` for each registration whose handler was not found. */
	readonly problems: string[];
}

/**
 * The source of another module, by the same kind of path the census was given
 * (`convex/mail/draftSend.ts`), or `undefined` when there is none.
 */
export type ModuleReader = (module: string) => string | undefined;

const CONVEX_BUILDER =
	/^(?:query|mutation|action|httpAction|internal(?:Query|Mutation|Action)|[A-Za-z0-9_$]*(?:Query|Mutation|Action))$/;

/** Names, wrappers and modules followed before a handler is given up on. */
const MAX_HOPS = 8;

/** A value a name can stand for: an expression, or a function declaration. */
type Value = ts.Expression | ts.FunctionDeclaration;

/** Wrappers that leave the value as it is: `(x)`, `x as T`, `x satisfies T`, `x!`. */
function unwrap(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isNonNullExpression(current) ||
		ts.isTypeAssertionExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

/** Follows names across the modules of one census run, parsing each module once. */
class Resolver {
	private readonly parsed = new Map<string, ts.SourceFile | null>();

	constructor(private readonly read: ModuleReader) {}

	parse(module: string, source: string): ts.SourceFile {
		const sourceFile = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
		this.parsed.set(module, sourceFile);
		return sourceFile;
	}

	/** The value `name` stands for where it is written, names followed. */
	value(expression: ts.Expression, hops = 0): Value | undefined {
		const value = unwrap(expression);
		if (!ts.isIdentifier(value)) return value;
		if (hops >= MAX_HOPS) return undefined;
		const local = resolveFunction(value);
		if (local) return local;
		return this.moduleLevel(value.getSourceFile(), value.text, hops + 1);
	}

	/** What the module-level binding `name` in `sourceFile` stands for. */
	private moduleLevel(sourceFile: ts.SourceFile, name: string, hops: number): Value | undefined {
		for (const statement of sourceFile.statements) {
			if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
			if (ts.isVariableStatement(statement)) {
				for (const declaration of statement.declarationList.declarations) {
					if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
					return declaration.initializer ? this.value(declaration.initializer, hops) : undefined;
				}
			}
			if (ts.isImportDeclaration(statement)) {
				const bindings = statement.importClause?.namedBindings;
				if (!bindings || !ts.isNamedImports(bindings)) continue;
				const element = bindings.elements.find((binding) => binding.name.text === name);
				if (!element) continue;
				const exported = (element.propertyName ?? element.name).text;
				return this.exported(sourceFile.fileName, statement.moduleSpecifier, exported, hops);
			}
			if (ts.isExportDeclaration(statement) && statement.exportClause) {
				// `export { local as name }` and `export { name } from './x'`.
				const clause = statement.exportClause;
				if (!ts.isNamedExports(clause)) continue;
				const element = clause.elements.find((binding) => binding.name.text === name);
				if (!element) continue;
				const original = (element.propertyName ?? element.name).text;
				if (statement.moduleSpecifier) {
					return this.exported(sourceFile.fileName, statement.moduleSpecifier, original, hops);
				}
				if (original !== name) return this.moduleLevel(sourceFile, original, hops + 1);
			}
		}
		return undefined;
	}

	/** The export `name` of the module `specifier` names, from `fromModule`. */
	private exported(
		fromModule: string,
		specifier: ts.Expression,
		name: string,
		hops: number
	): Value | undefined {
		if (hops >= MAX_HOPS || !ts.isStringLiteral(specifier)) return undefined;
		for (const candidate of resolveRelative(fromModule, specifier.text)) {
			const target = this.load(candidate);
			if (target) return this.moduleLevel(target, name, hops + 1);
		}
		return undefined;
	}

	private load(module: string): ts.SourceFile | undefined {
		const cached = this.parsed.get(module);
		if (cached !== undefined) return cached ?? undefined;
		const source = this.read(module);
		if (source === undefined) {
			this.parsed.set(module, null);
			return undefined;
		}
		return this.parse(module, source);
	}

	/** The handler function a definition's `handler` value stands for. */
	handlerFunction(expression: ts.Expression, hops = 0): FunctionLike | undefined {
		const value = this.value(expression);
		if (!value || hops >= MAX_HOPS) return undefined;
		if (isFunctionLiteral(value)) return value;
		if (ts.isCallExpression(value)) {
			// A wrapper (`deferredHandler(defer, handler)`) hands the handler on last.
			const last = value.arguments.at(-1);
			return last ? this.handlerFunction(last, hops + 1) : undefined;
		}
		return undefined;
	}

	/** The handler a registration's argument (a definition or the handler itself) names. */
	registered(argument: ts.Expression): FunctionLike | undefined {
		const value = this.value(argument);
		if (!value) return undefined;
		if (isFunctionLiteral(value)) return value;
		if (!ts.isObjectLiteralExpression(value)) return undefined;
		for (const property of value.properties) {
			if (!property.name || !ts.isIdentifier(property.name)) continue;
			if (property.name.text !== 'handler') continue;
			if (ts.isMethodDeclaration(property)) return property;
			if (ts.isPropertyAssignment(property)) return this.handlerFunction(property.initializer);
			if (ts.isShorthandPropertyAssignment(property)) return this.handlerFunction(property.name);
		}
		return undefined;
	}
}

function isRegistration(init: ts.Expression | undefined): init is ts.CallExpression {
	if (!init || !ts.isCallExpression(init)) return false;
	return ts.isIdentifier(init.expression) && CONVEX_BUILDER.test(init.expression.text);
}

function spanLines(fn: FunctionLike): number {
	const sourceFile = fn.getSourceFile();
	const first = sourceFile.getLineAndCharacterOfPosition(fn.getStart(sourceFile)).line;
	const last = sourceFile.getLineAndCharacterOfPosition(fn.getEnd()).line;
	return last - first + 1;
}

/**
 * Every registered handler in one module, in source order. `read` supplies
 * the modules its handlers are imported from.
 */
export function censusModule(
	module: string,
	source: string,
	read: ModuleReader = () => undefined
): ModuleCensus {
	const resolver = new Resolver(read);
	const sourceFile = resolver.parse(module, source);
	const handlers: HandlerSize[] = [];
	const problems: string[] = [];
	for (const statement of sourceFile.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name)) continue;
			if (!isRegistration(declaration.initializer)) continue;
			const name = declaration.name.text;
			const [argument] = declaration.initializer.arguments;
			const handler = argument ? resolver.registered(argument) : undefined;
			if (!handler) {
				const start = declaration.getStart(sourceFile);
				const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
				problems.push(
					`${module}:${line}: cannot find the handler of ${name}; hand the builder a definition object or a function the census can follow (see scripts/lib/handlerSize.ts)`
				);
				continue;
			}
			handlers.push({ module, name, lines: spanLines(handler) });
		}
	}
	return { handlers, problems };
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
