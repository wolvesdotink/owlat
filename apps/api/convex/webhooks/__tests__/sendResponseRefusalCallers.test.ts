/**
 * Every caller of `sendProviderDispatch` mirrors a send-response refusal (#1243).
 *
 * A provider can refuse an address off its own reject list in the send
 * response. The Mandrill webhook drops a later out-of-scope `reject` that
 * matches no Send on the strength of that mirror, so a caller that dispatches
 * and ignores `result.suppression` would let the address stay mailable.
 *
 * This reads the backend with the TypeScript parser, not a regex, so the forms
 * a text match misses are covered: a module that loads the dispatch module in
 * any way (named or aliased import, default or namespace import, a literal
 * dynamic `import()` or `require`) must contain a real call of
 * `recordSendResponseRefusal`, resolved through its import (an alias or a
 * namespace member counts; a comment or a string does not). Re-exporting the
 * dispatch module is refused outright: it would hand the dispatcher to modules
 * this walk then has to trust.
 *
 * Syntax only, per file, and only files whose text mentions `dispatch` are
 * parsed (any specifier that reaches the module contains that word), so the
 * walk stays fast.
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
	/** Calls the helper through a binding that resolves to it. */
	readonly callsHelper: boolean;
}

/** The module a relative specifier names, without extension or `/index`. */
function targetOf(fileName: string, specifier: string): string | null {
	if (!specifier.startsWith('.')) return null;
	return resolve(dirname(fileName), specifier)
		.replace(/\.(?:[cm]?[jt]s)$/, '')
		.replace(/[\\/]index$/, '');
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

/** Whether `node` is `import('<literal>')` or `require('<literal>')`, and its literal. */
function loadedSpecifier(node: ts.CallExpression): string | null {
	const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
	const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
	const [argument] = node.arguments;
	if (!(isImport || isRequire) || !argument) return null;
	return ts.isStringLiteralLike(argument) ? argument.text : null;
}

function analyzeCaller(fileName: string, source: string): CallerVerdict {
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false);
	const is = (specifier: ts.Expression | undefined, target: string): boolean =>
		specifier !== undefined &&
		ts.isStringLiteralLike(specifier) &&
		targetOf(fileName, specifier.text) === target;

	let loadsDispatcher = false;
	let reexportsDispatcher = false;
	let callsHelper = false;
	const helperNames = new Set<string>();
	const suppressionNamespaces = new Set<string>();

	// Import bindings first, so a call anywhere in the file resolves against them.
	for (const statement of file.statements) {
		if (ts.isImportDeclaration(statement)) {
			if (is(statement.moduleSpecifier, DISPATCH_MODULE)) {
				if (!isTypeOnlyImport(statement.importClause)) loadsDispatcher = true;
			}
			if (is(statement.moduleSpecifier, SUPPRESSION_MODULE)) {
				const bindings = statement.importClause?.namedBindings;
				if (bindings && ts.isNamespaceImport(bindings)) {
					suppressionNamespaces.add(bindings.name.text);
				} else if (bindings && ts.isNamedImports(bindings)) {
					for (const element of bindings.elements) {
						const imported = (element.propertyName ?? element.name).text;
						if (imported === HELPER && !element.isTypeOnly) helperNames.add(element.name.text);
					}
				}
			}
		} else if (
			ts.isExportDeclaration(statement) &&
			is(statement.moduleSpecifier, DISPATCH_MODULE)
		) {
			if (!statement.isTypeOnly) reexportsDispatcher = true;
		}
	}

	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const loaded = loadedSpecifier(node);
			if (loaded !== null && targetOf(fileName, loaded) === DISPATCH_MODULE) {
				loadsDispatcher = true;
			}
			const callee = node.expression;
			if (ts.isIdentifier(callee) && helperNames.has(callee.text)) callsHelper = true;
			if (
				ts.isPropertyAccessExpression(callee) &&
				ts.isIdentifier(callee.expression) &&
				suppressionNamespaces.has(callee.expression.text) &&
				callee.name.text === HELPER
			) {
				callsHelper = true;
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);

	return { loadsDispatcher, reexportsDispatcher, callsHelper };
}

function productionFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : productionFiles(path);
		return entry.name.endsWith('.ts') && !/\.(?:test|spec)\.ts$/.test(entry.name) ? [path] : [];
	});
}

describe('send-response refusal callers', () => {
	const verdicts = productionFiles(CONVEX_ROOT)
		.map((path) => ({ path, source: readFileSync(path, 'utf8') }))
		.filter(({ source }) => source.includes('dispatch'))
		.map(({ path, source }) => ({
			path: relative(CONVEX_ROOT, path),
			...analyzeCaller(path, source),
		}));
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
	const analyze = (source: string) => analyzeCaller(FILE, source);

	it.each([
		['a named import', `import { sendProviderDispatch } from '${DISPATCH}';`],
		['an aliased import', `import { sendProviderDispatch as send } from '${DISPATCH}';`],
		['a namespace import', `import * as dispatch from '${DISPATCH}';`],
		['a double-quoted import', `import { sendProviderDispatch } from "${DISPATCH}";`],
		['an import with an extension', `import { sendProviderDispatch } from '${DISPATCH}.js';`],
		['a dynamic import', `const m = await import('${DISPATCH}');`],
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
	])('credits %s of the helper', (_form, source) => {
		expect(analyze(source).callsHelper).toBe(true);
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
	])('does not credit %s', (_form, source) => {
		expect(analyze(source).callsHelper).toBe(false);
	});
});
