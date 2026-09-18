#!/usr/bin/env bun
/**
 * Node-global gate for the Convex V8 (isolate) runtime.
 *
 * Convex runs a deployment's functions in two different runtimes. A module that
 * opens with `'use node'` is bundled for Node and gets the Node standard
 * library; EVERY OTHER module runs in the V8 isolate, where `Buffer`,
 * `setImmediate`, `__dirname` and the `node:*` builtins DO NOT EXIST. Touching
 * one there is not a build error — it is a `ReferenceError` thrown at call time,
 * inside a single function invocation, which Convex reports as a per-call
 * failure and nothing else notices.
 *
 * That blind spot shipped: `mail/external/delivery.ts::ingestExternalRaw` (the
 * IMAP-sync ingest) opened its handler with `Buffer.from(base64)`, so every
 * message a connected mailbox ever synced or imported threw on the first line
 * and the mailbox stayed empty while the migration reported "100% imported".
 * Unit tests could not catch it: `convex-test` runs under vitest in Node, where
 * `Buffer` is defined, so the whole path was green.
 *
 * So the runtime split has to be checked statically. This gate walks the import
 * graph from every isolate-runtime module under `apps/api/convex/` — following
 * value imports only (a type-only import is erased and bundles nothing) and
 * rejecting a value-import edge into a `'use node'` module (the two runtimes
 * cannot share that bundle) — and fails on any Node global used in a VALUE
 * position, or any `node:*` import, in the modules it reaches. Type positions
 * are ignored: `rawBytes: Buffer` is erased at build time and cannot throw.
 *
 * Run by `bun run lint:convex-globals`, and from `ci:lint` / `ci:verify`.
 * Exercised against throwaway trees by
 * `scripts/__tests__/check-convex-node-globals.test.ts`, run by the same gate.
 */

import { builtinModules } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Every Node builtin, in BOTH spellings. `node:crypto` and a bare `crypto` are
 * the same module to the bundler; only checking the prefixed form would let the
 * spelling already used in this tree (`delivery/contactToken.ts` imports from
 * `'crypto'`) walk past the gate the day someone drops a `'use node'`.
 */
const NODE_BUILTIN_SPECIFIERS: ReadonlySet<string> = new Set(
	builtinModules.flatMap((name) => [name, `node:${name}`])
);

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONVEX_DIR = 'apps/api/convex';

/**
 * Globals the Node runtime provides and the Convex isolate does not.
 *
 * `process` is deliberately absent: Convex exposes `process.env` in the isolate
 * too, and this repository already routes every read through `lib/env.ts` under
 * its own gate (`bun run --cwd apps/api lint:env`).
 */
export const NODE_ONLY_GLOBALS: readonly string[] = Object.freeze([
	'Buffer',
	'setImmediate',
	'clearImmediate',
	'__dirname',
	'__filename',
]);

export interface NodeGlobalsCheckOptions {
	/** Repository root to search. Defaults to this repository. */
	readonly root?: string;
	/** Directory holding the Convex deployment, relative to `root`. */
	readonly convexDir?: string;
}

/** One offending reference, with the isolate module that reaches it. */
export interface NodeGlobalUse {
	/** Repository-relative path of the file holding the reference. */
	readonly file: string;
	/** 1-indexed line of the reference. */
	readonly line: number;
	/** The global, or the `node:*` specifier, that cannot resolve in the isolate. */
	readonly symbol: string;
	/**
	 * Repository-relative path of the isolate-runtime Convex module whose import
	 * graph reaches `file`. Equal to `file` when the module is itself the entry.
	 */
	readonly reachedFrom: string;
}

function isSource(path: string): boolean {
	if (path.includes('/__tests__/')) return false;
	if (path.includes('/_generated/')) return false;
	if (path.endsWith('.test.ts')) return false;
	return path.endsWith('.ts');
}

async function collectConvexModules(root: string, convexDir: string): Promise<string[]> {
	const files: string[] = [];
	async function walk(relativeDir: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(join(root, relativeDir), { withFileTypes: true });
		} catch {
			return; // A Convex directory that does not exist contributes nothing.
		}
		for (const entry of entries) {
			const child = `${relativeDir}/${entry.name}`;
			if (entry.isDirectory()) {
				if (entry.name !== 'node_modules') await walk(child);
			} else if (isSource(child)) {
				files.push(child);
			}
		}
	}
	await walk(convexDir);
	return files.sort();
}

function parse(path: string, source: string): ts.SourceFile {
	return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** True when the module opens with the `'use node'` directive. */
function isNodeRuntimeModule(sourceFile: ts.SourceFile): boolean {
	const first = sourceFile.statements[0];
	if (!first || !ts.isExpressionStatement(first)) return false;
	return ts.isStringLiteral(first.expression) && first.expression.text === 'use node';
}

/**
 * Module specifiers this file pulls into its bundle. Type-only imports and
 * exports are skipped: TypeScript erases them, so they never reach a runtime.
 */
function valueImportSpecifiers(sourceFile: ts.SourceFile): string[] {
	const specifiers: string[] = [];
	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement)) {
			const clause = statement.importClause;
			// A side-effect import (`import './x'`) has no clause and always runs.
			if (clause?.isTypeOnly) continue;
			const bindings = clause?.namedBindings;
			if (
				bindings !== undefined &&
				ts.isNamedImports(bindings) &&
				clause?.name === undefined &&
				bindings.elements.every((element) => element.isTypeOnly)
			) {
				continue; // every named binding is `import { type X }` — all erased
			}
			if (ts.isStringLiteral(statement.moduleSpecifier)) {
				specifiers.push(statement.moduleSpecifier.text);
			}
		} else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
			if (statement.isTypeOnly) continue;
			const clause = statement.exportClause;
			if (
				clause !== undefined &&
				ts.isNamedExports(clause) &&
				clause.elements.every((element) => element.isTypeOnly)
			) {
				continue;
			}
			if (ts.isStringLiteral(statement.moduleSpecifier)) {
				specifiers.push(statement.moduleSpecifier.text);
			}
		}
	}
	return specifiers;
}

/** The source line of a value import/re-export, used to report runtime edges. */
function valueImportLine(sourceFile: ts.SourceFile, wanted: string): number {
	for (const statement of sourceFile.statements) {
		const moduleSpecifier = ts.isImportDeclaration(statement)
			? statement.moduleSpecifier
			: ts.isExportDeclaration(statement)
				? statement.moduleSpecifier
				: undefined;
		if (
			moduleSpecifier !== undefined &&
			ts.isStringLiteral(moduleSpecifier) &&
			moduleSpecifier.text === wanted &&
			valueImportSpecifiers(sourceFile).includes(wanted)
		) {
			return (
				sourceFile.getLineAndCharacterOfPosition(moduleSpecifier.getStart(sourceFile)).line + 1
			);
		}
	}
	return 1;
}

/**
 * Resolve an import to a repository-relative source path, or null when it
 * leaves the tree this gate can see (an npm dependency, a type-only package).
 * Relative specifiers resolve against the importing file; `@owlat/<pkg>/<sub>`
 * resolves into that workspace's `src/`, because those sources are bundled into
 * the deployment alongside the Convex modules.
 */
function resolveSpecifier(
	importer: string,
	specifier: string,
	known: ReadonlySet<string>
): string | null {
	let base: string;
	if (specifier.startsWith('.')) {
		base = join(dirname(importer), specifier);
	} else if (specifier.startsWith('@owlat/')) {
		const [pkg, ...sub] = specifier.slice('@owlat/'.length).split('/');
		base = join('packages', pkg!, 'src', sub.length > 0 ? sub.join('/') : 'index');
	} else {
		return null;
	}
	// A `.js` specifier is TypeScript's NodeNext spelling of a `.ts` source.
	if (base.endsWith('.js')) base = base.slice(0, -'.js'.length);
	for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
		if (known.has(candidate)) return candidate;
	}
	return null;
}

/** True when this identifier names a property rather than a free variable. */
function isPropertyName(node: ts.Identifier): boolean {
	const parent = node.parent;
	if (parent === undefined) return false;
	if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
	if (ts.isQualifiedName(parent)) return parent.right === node;
	if (ts.isPropertyAssignment(parent)) return parent.name === node;
	if (ts.isPropertySignature(parent)) return parent.name === node;
	if (ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent)) return parent.name === node;
	if (ts.isBindingElement(parent)) return parent.propertyName === node;
	if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
	return false;
}

/** Free references to `globals` in value positions, with their 1-indexed lines. */
function findGlobalUses(
	sourceFile: ts.SourceFile,
	globals: readonly string[]
): { symbol: string; line: number }[] {
	const wanted = new Set(globals);
	const found: { symbol: string; line: number }[] = [];
	// A module that gives the name its OWN top-level binding shadows the global,
	// and the reference resolves fine in the isolate. Two kinds do not count:
	//
	//   · `declare const Buffer: …` — a type-space assertion that emits NOTHING.
	//     It is the one-line way a developer silences the type error and puts the
	//     original ReferenceError straight back;
	//   · a binding imported FROM a Node builtin (`import { Buffer } from
	//     'buffer'`, which is what IDE auto-import offers) — that import is
	//     itself the problem, and is reported separately.
	const shadowed = new Set<string>();
	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement)) {
			if (
				ts.isStringLiteral(statement.moduleSpecifier) &&
				NODE_BUILTIN_SPECIFIERS.has(statement.moduleSpecifier.text)
			) {
				continue;
			}
			const bindings = statement.importClause?.namedBindings;
			if (bindings !== undefined && ts.isNamedImports(bindings)) {
				for (const element of bindings.elements) shadowed.add(element.name.text);
			}
			const defaultName = statement.importClause?.name;
			if (defaultName !== undefined) shadowed.add(defaultName.text);
		} else if (ts.isVariableStatement(statement)) {
			const isAmbient = statement.modifiers?.some(
				(modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword
			);
			if (isAmbient === true) continue;
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) shadowed.add(declaration.name.text);
			}
		} else if (ts.isFunctionDeclaration(statement) && statement.name) {
			shadowed.add(statement.name.text);
		}
	}

	/** Names bound by the construct at hand — a parameter, a catch, a local. */
	function localNames(node: ts.Node): string[] {
		const names: string[] = [];
		const collect = (name: ts.BindingName): void => {
			if (ts.isIdentifier(name)) names.push(name.text);
			else
				for (const element of name.elements) {
					if (ts.isBindingElement(element)) collect(element.name);
				}
		};
		if (ts.isFunctionLike(node)) {
			for (const parameter of node.parameters) collect(parameter.name);
			if (!ts.isArrowFunction(node) && node.name && ts.isIdentifier(node.name)) {
				names.push(node.name.text);
			}
		} else if (ts.isCatchClause(node) && node.variableDeclaration) {
			collect(node.variableDeclaration.name);
		} else if (ts.isVariableStatement(node)) {
			for (const declaration of node.declarationList.declarations) collect(declaration.name);
		}
		return names;
	}

	function visit(node: ts.Node, scope: ReadonlySet<string>): void {
		// Types are erased before the bundle exists, so `x: Buffer` cannot throw.
		// A HERITAGE clause is the exception: `class X extends Buffer {}` parses as
		// a type node but evaluates the expression, and throws at MODULE LOAD.
		const isHeritageExpression =
			ts.isExpressionWithTypeArguments(node) &&
			node.parent !== undefined &&
			ts.isHeritageClause(node.parent);
		if (
			!isHeritageExpression &&
			(ts.isTypeNode(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node))
		) {
			return;
		}
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
		// `typeof X` on an undeclared name is the one reference that CANNOT throw —
		// it is how a module feature-detects the runtime it is in.
		if (ts.isTypeOfExpression(node) && ts.isIdentifier(node.expression)) return;
		if (ts.isIdentifier(node) && wanted.has(node.text) && !shadowed.has(node.text)) {
			if (!isPropertyName(node) && !scope.has(node.text)) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
				found.push({ symbol: node.text, line: line + 1 });
			}
			return;
		}
		const bound = localNames(node);
		const inner = bound.length > 0 ? new Set([...scope, ...bound]) : scope;
		ts.forEachChild(node, (child) => visit(child, inner));
	}
	ts.forEachChild(sourceFile, (node) => visit(node, new Set<string>()));
	return found;
}

/**
 * Every Node builtin the module pulls in, with its 1-indexed line — static
 * imports/re-exports, plus the two dynamic forms (`await import('node:fs')`,
 * `require('buffer')`) that a static import-declaration walk would miss.
 */
function findNodeBuiltinImports(sourceFile: ts.SourceFile): { symbol: string; line: number }[] {
	const valueImports = new Set(valueImportSpecifiers(sourceFile));
	const found: { symbol: string; line: number }[] = [];
	const at = (node: ts.Node): number =>
		sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

	for (const statement of sourceFile.statements) {
		const moduleSpecifier = ts.isImportDeclaration(statement)
			? statement.moduleSpecifier
			: ts.isExportDeclaration(statement)
				? statement.moduleSpecifier
				: undefined;
		if (moduleSpecifier === undefined || !ts.isStringLiteral(moduleSpecifier)) continue;
		if (!NODE_BUILTIN_SPECIFIERS.has(moduleSpecifier.text)) continue;
		if (!valueImports.has(moduleSpecifier.text)) continue;
		found.push({ symbol: moduleSpecifier.text, line: at(moduleSpecifier) });
	}

	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
			const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
			const argument = node.arguments[0];
			if (
				(isDynamic || isRequire) &&
				argument !== undefined &&
				ts.isStringLiteral(argument) &&
				NODE_BUILTIN_SPECIFIERS.has(argument.text)
			) {
				found.push({ symbol: argument.text, line: at(argument) });
			}
		}
		ts.forEachChild(node, visit);
	};
	ts.forEachChild(sourceFile, visit);
	return found;
}

/**
 * Every Node-only reference reachable from the isolate runtime, in file order.
 * An empty array means the V8 bundle touches nothing Node-specific.
 */
export async function findConvexNodeGlobalUses(
	options: NodeGlobalsCheckOptions = {}
): Promise<NodeGlobalUse[]> {
	const root = options.root ?? REPOSITORY_ROOT;
	const convexDir = options.convexDir ?? CONVEX_DIR;
	const convexModules = await collectConvexModules(root, convexDir);

	const sources = new Map<string, ts.SourceFile>();
	const load = async (path: string): Promise<ts.SourceFile | null> => {
		const cached = sources.get(path);
		if (cached) return cached;
		let text: string;
		try {
			text = await readFile(join(root, path), 'utf8');
		} catch {
			return null;
		}
		const parsed = parse(path, text);
		sources.set(path, parsed);
		return parsed;
	};

	// The set of paths a specifier may resolve to: the Convex tree plus every
	// workspace source file it can reach through an `@owlat/*` import.
	const known = new Set<string>(convexModules);
	async function indexWorkspaceSources(): Promise<void> {
		let packages: string[];
		try {
			packages = (await readdir(join(root, 'packages'), { withFileTypes: true }))
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name);
		} catch {
			return;
		}
		for (const pkg of packages) {
			const stack = [`packages/${pkg}/src`];
			while (stack.length > 0) {
				const dir = stack.pop()!;
				let entries;
				try {
					entries = await readdir(join(root, dir), { withFileTypes: true });
				} catch {
					continue;
				}
				for (const entry of entries) {
					const child = `${dir}/${entry.name}`;
					if (entry.isDirectory()) {
						if (entry.name !== 'node_modules') stack.push(child);
					} else if (isSource(child)) {
						known.add(child);
					}
				}
			}
		}
	}
	await indexWorkspaceSources();

	// Breadth-first from every isolate-runtime Convex module. A value import into
	// a `'use node'` module is itself invalid: silently stopping there used to
	// turn the runtime boundary into an unenforced assumption.
	const reachedFrom = new Map<string, string>();
	const runtimeEdges: NodeGlobalUse[] = [];
	const queue: string[] = [];
	for (const path of convexModules) {
		const sourceFile = await load(path);
		if (!sourceFile || isNodeRuntimeModule(sourceFile)) continue;
		reachedFrom.set(path, path);
		queue.push(path);
	}
	for (let index = 0; index < queue.length; index++) {
		const path = queue[index]!;
		const sourceFile = sources.get(path)!;
		for (const specifier of valueImportSpecifiers(sourceFile)) {
			const target = resolveSpecifier(path, specifier, known);
			if (target === null || reachedFrom.has(target)) continue;
			const targetSource = await load(target);
			if (!targetSource) continue;
			if (isNodeRuntimeModule(targetSource)) {
				runtimeEdges.push({
					file: path,
					line: valueImportLine(sourceFile, specifier),
					symbol: `${specifier} ('use node')`,
					reachedFrom: reachedFrom.get(path)!,
				});
				continue;
			}
			reachedFrom.set(target, reachedFrom.get(path)!);
			queue.push(target);
		}
	}

	const uses: NodeGlobalUse[] = [...runtimeEdges];
	for (const path of [...reachedFrom.keys()].sort()) {
		const sourceFile = sources.get(path)!;
		const hits = [
			...findGlobalUses(sourceFile, NODE_ONLY_GLOBALS),
			...findNodeBuiltinImports(sourceFile),
		];
		for (const hit of hits.sort((a, b) => a.line - b.line)) {
			uses.push({
				file: path,
				line: hit.line,
				symbol: hit.symbol,
				reachedFrom: reachedFrom.get(path)!,
			});
		}
	}
	return uses;
}

if (import.meta.main) {
	const uses = await findConvexNodeGlobalUses();
	if (uses.length > 0) {
		console.error(
			'Convex isolate-runtime modules reference Node-only APIs. The V8 runtime has no\n' +
				'Buffer / node: builtins, so each of these throws a ReferenceError at call time:\n'
		);
		for (const use of uses) {
			const via = use.reachedFrom === use.file ? '' : ` (reached from ${use.reachedFrom})`;
			console.error(`  - ${use.file}:${use.line}  ${use.symbol}${via}`);
		}
		console.error(
			`\nUse the Web equivalents (apps/api/convex/lib/bytes.ts, TextEncoder/TextDecoder,\n` +
				`crypto.subtle), or move the module to the Node runtime with 'use node'.`
		);
		process.exit(1);
	}
	console.log(
		`Convex isolate-runtime modules touch no Node-only APIs (${relative('.', CONVEX_DIR)}).`
	);
}
