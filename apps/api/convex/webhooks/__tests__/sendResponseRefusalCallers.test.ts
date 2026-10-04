/**
 * Every caller of `sendProviderDispatch` mirrors a send-response refusal (#1243).
 *
 * A provider can refuse an address off its own reject list in the send
 * response. The Mandrill webhook drops a later out-of-scope `reject` that
 * matches no Send on the strength of that mirror, so a caller that dispatches
 * and ignores `result.suppression` would let the address stay mailable.
 *
 * Two passes, both on the TypeScript compiler's view of the source rather than
 * its text:
 *
 *  1. Every production module is PARSED, and its module specifiers are read as
 *     the compiler reads them (so an escaped `'dispatch'` is `dispatch`).
 *     A module that loads the dispatch module in any form (named, aliased,
 *     default or namespace import, a literal dynamic `import()` or `require`) is
 *     a caller; a module that re-exports it is refused outright, because it would
 *     hand the dispatcher to modules this walk would then have to trust.
 *  2. The callers are BOUND by a program over just those files, and each must
 *     contain a call whose callee the type checker resolves to the import of
 *     `recordSendResponseRefusal` from `webhooks/providerSuppression` (directly,
 *     aliased, or as a member of a namespace import of that module). Scope is
 *     the checker's: a parameter or local that shadows the import gets no
 *     credit, and neither does a comment or a string.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const CONVEX_ROOT = resolve(__dirname, '..', '..');
const DISPATCH_MODULE = join(CONVEX_ROOT, 'lib', 'sendProviders', 'dispatch');
const SUPPRESSION_MODULE = join(CONVEX_ROOT, 'webhooks', 'providerSuppression');
const HELPER = 'recordSendResponseRefusal';
const SKIPPED_DIRS = new Set(['__tests__', '_generated', 'node_modules']);

interface CallerVerdict {
	/** Loads the dispatch module at runtime. */
	readonly loadsDispatcher: boolean;
	/** Re-exports from the dispatch module. */
	readonly reexportsDispatcher: boolean;
	/** Calls the helper through its import binding (checked for callers only). */
	readonly callsHelper: boolean;
}

/** The module a relative specifier names, without extension or `/index`. */
function targetOf(fileName: string, specifier: string): string | null {
	if (!specifier.startsWith('.')) return null;
	return resolve(dirname(fileName), specifier)
		.replace(/\.(?:[cm]?[jt]s)$/, '')
		.replace(/[\\/]index$/, '');
}

function names(fileName: string, specifier: ts.Node | undefined, target: string): boolean {
	return (
		specifier !== undefined &&
		ts.isStringLiteralLike(specifier) &&
		targetOf(fileName, specifier.text) === target
	);
}

function isTypeOnlyImport(clause: ts.ImportClause | undefined): boolean {
	if (!clause) return false;
	if (clause.isTypeOnly) return true;
	const bindings = clause.namedBindings;
	return (
		clause.name === undefined &&
		bindings !== undefined &&
		ts.isNamedImports(bindings) &&
		bindings.elements.length > 0 &&
		bindings.elements.every((element) => element.isTypeOnly)
	);
}

/** `import('<literal>')` or `require('<literal>')`: the literal; otherwise null. */
function loadedSpecifier(node: ts.CallExpression): ts.Node | null {
	const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
	const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
	return (isImport || isRequire) && node.arguments[0] ? node.arguments[0] : null;
}

/** Pass 1: how a parsed module reaches the dispatch module. */
function dispatcherEdges(file: ts.SourceFile): Omit<CallerVerdict, 'callsHelper'> {
	let loadsDispatcher = false;
	let reexportsDispatcher = false;
	const visit = (node: ts.Node): void => {
		if (
			ts.isImportDeclaration(node) &&
			names(file.fileName, node.moduleSpecifier, DISPATCH_MODULE)
		) {
			if (!isTypeOnlyImport(node.importClause)) loadsDispatcher = true;
		} else if (
			ts.isExportDeclaration(node) &&
			names(file.fileName, node.moduleSpecifier, DISPATCH_MODULE) &&
			!node.isTypeOnly
		) {
			reexportsDispatcher = true;
		} else if (ts.isCallExpression(node)) {
			const loaded = loadedSpecifier(node);
			if (loaded && names(file.fileName, loaded, DISPATCH_MODULE)) loadsDispatcher = true;
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return { loadsDispatcher, reexportsDispatcher };
}

/** The import declaration a binding element belongs to. */
function importDeclarationOf(declaration: ts.Declaration): ts.ImportDeclaration | null {
	let node: ts.Node | undefined = declaration;
	while (node && !ts.isImportDeclaration(node)) node = node.parent;
	return node ?? null;
}

/** Whether `symbol` is THE import of the helper (named or aliased), not a shadow. */
function isHelperImport(symbol: ts.Symbol | undefined): boolean {
	return (symbol?.declarations ?? []).some((declaration) => {
		if (!ts.isImportSpecifier(declaration) || declaration.isTypeOnly) return false;
		if ((declaration.propertyName ?? declaration.name).text !== HELPER) return false;
		const owner = importDeclarationOf(declaration);
		return (
			owner !== null &&
			!owner.importClause?.isTypeOnly &&
			names(owner.getSourceFile().fileName, owner.moduleSpecifier, SUPPRESSION_MODULE)
		);
	});
}

/** Whether `symbol` is a namespace import of the helper's module, not a shadow. */
function isSuppressionNamespace(symbol: ts.Symbol | undefined): boolean {
	return (symbol?.declarations ?? []).some((declaration) => {
		if (!ts.isNamespaceImport(declaration)) return false;
		const owner = importDeclarationOf(declaration);
		return (
			owner !== null &&
			!owner.importClause?.isTypeOnly &&
			names(owner.getSourceFile().fileName, owner.moduleSpecifier, SUPPRESSION_MODULE)
		);
	});
}

/** Pass 2: bind `sources` and report which of them call the helper. */
function helperCallers(sources: ReadonlyMap<string, string>): Set<string> {
	const options: ts.CompilerOptions = {
		noResolve: true,
		noLib: true,
		types: [],
		target: ts.ScriptTarget.Latest,
		module: ts.ModuleKind.ESNext,
	};
	const host: ts.CompilerHost = {
		getSourceFile: (fileName, languageVersion) => {
			const text = sources.get(fileName);
			return text === undefined
				? undefined
				: ts.createSourceFile(fileName, text, languageVersion, true);
		},
		getDefaultLibFileName: () => 'lib.d.ts',
		writeFile: () => undefined,
		getCurrentDirectory: () => CONVEX_ROOT,
		getCanonicalFileName: (fileName) => fileName,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => '\n',
		fileExists: (fileName) => sources.has(fileName),
		readFile: (fileName) => sources.get(fileName),
	};
	const program = ts.createProgram([...sources.keys()], options, host);
	const checker = program.getTypeChecker();
	const callers = new Set<string>();
	for (const file of program.getSourceFiles()) {
		const visit = (node: ts.Node): void => {
			if (callers.has(file.fileName)) return;
			if (ts.isCallExpression(node)) {
				const callee = node.expression;
				if (ts.isIdentifier(callee) && isHelperImport(checker.getSymbolAtLocation(callee))) {
					callers.add(file.fileName);
				} else if (
					ts.isPropertyAccessExpression(callee) &&
					callee.name.text === HELPER &&
					ts.isIdentifier(callee.expression) &&
					isSuppressionNamespace(checker.getSymbolAtLocation(callee.expression))
				) {
					callers.add(file.fileName);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(file);
	}
	return callers;
}

/** Both passes over a set of modules, keyed by file name. */
function analyzeCallers(sources: ReadonlyMap<string, string>): Map<string, CallerVerdict> {
	const edges = new Map(
		[...sources].map(([fileName, text]) => [
			fileName,
			dispatcherEdges(ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)),
		])
	);
	const candidates = new Map(
		[...sources].filter(([fileName]) => edges.get(fileName)?.loadsDispatcher)
	);
	const calling = helperCallers(candidates);
	return new Map(
		[...edges].map(([fileName, edge]) => [
			fileName,
			{ ...edge, callsHelper: calling.has(fileName) },
		])
	);
}

function productionFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : productionFiles(path);
		return entry.name.endsWith('.ts') && !/\.(?:test|spec)\.ts$/.test(entry.name) ? [path] : [];
	});
}

describe('send-response refusal callers', () => {
	const verdicts = [
		...analyzeCallers(
			new Map(productionFiles(CONVEX_ROOT).map((path) => [path, readFileSync(path, 'utf8')]))
		),
	].map(([path, verdict]) => ({ path: relative(CONVEX_ROOT, path), ...verdict }));
	const callers = verdicts.filter((verdict) => verdict.loadsDispatcher);

	it('finds the known callers', () => {
		expect(callers.map((caller) => caller.path).sort()).toEqual([
			join('delivery', 'governedDispatch.ts'),
			'systemMail.ts',
		]);
	});

	it('finds no module that re-exports the dispatcher', () => {
		expect(verdicts.filter((verdict) => verdict.reexportsDispatcher).map((v) => v.path)).toEqual(
			[]
		);
	});

	it.each(callers.map((caller) => [caller.path, caller.callsHelper] as const))(
		'%s mirrors the refusal',
		(_path, callsHelper) => {
			expect(callsHelper).toBe(true);
		}
	);
});

describe('the caller analysis', () => {
	// A fixture lives where a real caller would, so relative specifiers resolve.
	const FILE = join(CONVEX_ROOT, 'delivery', 'fixtureCaller.ts');
	const DISPATCH = '../lib/sendProviders/dispatch';
	const SUPPRESSION = '../webhooks/providerSuppression';
	const LOADS = `import { sendProviderDispatch } from '${DISPATCH}';\n`;
	const analyze = (source: string): CallerVerdict =>
		analyzeCallers(new Map([[FILE, source]])).get(FILE)!;

	it.each([
		['a named import', `import { sendProviderDispatch } from '${DISPATCH}';`],
		['an aliased import', `import { sendProviderDispatch as send } from '${DISPATCH}';`],
		['a namespace import', `import * as dispatch from '${DISPATCH}';`],
		['a double-quoted import', `import { sendProviderDispatch } from "${DISPATCH}";`],
		['an import with an extension', `import { sendProviderDispatch } from '${DISPATCH}.js';`],
		[
			'an escaped specifier',
			`import { sendProviderDispatch } from '../lib/sendProviders/\\u0064ispatch';`,
		],
		['a dynamic import', `async function f() { return await import('${DISPATCH}'); }`],
		['a require', `const m = require("${DISPATCH}");`],
	])('sees %s of the dispatcher', (_form, source) => {
		expect(analyze(source).loadsDispatcher).toBe(true);
	});

	it('does not count a type-only import as loading the dispatcher', () => {
		expect(analyze(`import type { DispatchResult } from '${DISPATCH}';`).loadsDispatcher).toBe(
			false
		);
		expect(analyze(`import { type DispatchResult } from '${DISPATCH}';`).loadsDispatcher).toBe(
			false
		);
	});

	it.each([
		['a named re-export', `export { sendProviderDispatch } from '${DISPATCH}';`],
		['a star re-export', `export * from "${DISPATCH}";`],
		['a namespace re-export', `export * as dispatch from '${DISPATCH}';`],
	])('flags %s of the dispatcher', (_form, source) => {
		expect(analyze(source).reexportsDispatcher).toBe(true);
	});

	it.each([
		['a direct call', `import { ${HELPER} } from '${SUPPRESSION}';\n${HELPER}(ctx, args);`],
		[
			'an aliased call',
			`import { ${HELPER} as mirror } from '${SUPPRESSION}';\nawait mirror(ctx, args);`,
		],
		[
			'a namespace member call',
			`import * as suppression from "${SUPPRESSION}";\nawait suppression.${HELPER}(ctx, args);`,
		],
		[
			'a call in a nested function',
			`import { ${HELPER} } from '${SUPPRESSION}';\n` +
				`export async function outer() {\n\tconst inner = async () => {\n\t\tawait ${HELPER}(ctx, args);\n\t};\n\tawait inner();\n}`,
		],
	])('credits %s of the helper', (_form, source) => {
		expect(analyze(LOADS + source).callsHelper).toBe(true);
	});

	it.each([
		['a comment', `import { ${HELPER} } from '${SUPPRESSION}';\n// ${HELPER}(ctx, args);`],
		['a block comment', `/* ${HELPER}(ctx, args) */`],
		['a string', `const note = '${HELPER}(ctx, args)';`],
		['an import without a call', `import { ${HELPER} } from '${SUPPRESSION}';`],
		[
			'a same-named function from elsewhere',
			`import { ${HELPER} } from './somewhereElse';\n${HELPER}(ctx, args);`,
		],
		['an unimported global of that name', `${HELPER}(ctx, args);`],
		[
			'a shadowing parameter',
			`import { ${HELPER} } from '${SUPPRESSION}';\n` +
				`export async function f(${HELPER}: (...a: unknown[]) => void) {\n\t${HELPER}(ctx, args);\n}`,
		],
		[
			'a shadowing local const',
			`import { ${HELPER} } from '${SUPPRESSION}';\n` +
				`export function f() {\n\tconst ${HELPER} = () => undefined;\n\t${HELPER}();\n}`,
		],
		[
			'a shadowed namespace',
			`import * as suppression from '${SUPPRESSION}';\n` +
				`export function f(suppression: { ${HELPER}: () => void }) {\n\tsuppression.${HELPER}();\n}`,
		],
	])('does not credit %s', (_form, source) => {
		expect(analyze(LOADS + source).callsHelper).toBe(false);
	});
});
