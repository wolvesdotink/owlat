/**
 * Convex function builders and the functions registered with them.
 *
 * Which names are public builders, and the kind and auth floor each enforces,
 * is derived from source by `apps/api/scripts/lib/convex-builders.sh`: the
 * exports of `convex/lib/authedFunctions.ts` plus every `featureGated(Any)`
 * composition under `convex/`. The rules read the same inputs (the script's
 * own `CONVEX_BASE_BUILDERS` classification and the composition lines under
 * `convex/`) rather than keep a second list that could drift from it, and
 * src/lib/__tests__/convexBuilders.test.ts pins both derivations to the same
 * table. The plugin cannot run the script itself: forking oxlint's large
 * process fails with ENOMEM on a loaded host. The table is derived once per
 * `apps/api` root and lint process. A derivation that fails (an unclassified builder
 * export, an unknown composition base) is reported on every file that needs it,
 * so a rule never runs against a silently shrunken builder set.
 *
 * A call site resolves its builder by binding rather than by spelling: an
 * aliased import (`import { postboxQuery as pq }`) and a namespace member
 * (`fns.authedQuery`) resolve to the exported name, and the raw Convex builders
 * are recognized by the module they come from (`_generated/server`,
 * `convex/server`), not by the word `query`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { AstNode, Context } from '../types.ts';
import { bindingOf, importedThrough, unwrap, type Node } from './ast.ts';

export type BuilderKind = 'query' | 'mutation' | 'action';
/** `raw` is a bare Convex builder: no floor at all, and not a wrapper. */
export type BuilderFloor = 'member' | 'role' | 'identity' | 'public' | 'raw';

interface Builder {
	name: string;
	kind: BuilderKind;
	floor: BuilderFloor;
}

type BuilderTable = ReadonlyMap<string, Builder>;

const RAW_KINDS: Readonly<Record<string, BuilderKind>> = {
	query: 'query',
	mutation: 'mutation',
	action: 'action',
	queryGeneric: 'query',
	mutationGeneric: 'mutation',
	actionGeneric: 'action',
};

/** `./_generated/server`, `../../_generated/server.js`, … */
const GENERATED_SERVER = /(?:^|\/)_generated\/server(?:\.[cm]?js)?$/u;

/**
 * The raw Convex builder an import names, if it is one: `query` / `mutation` /
 * `action` from the generated server module, or their `*Generic` originals
 * from `convex/server`.
 */
export const rawBuilderKind = (source: string, imported: string): BuilderKind | undefined => {
	if (GENERATED_SERVER.test(source)) {
		return imported === 'query' || imported === 'mutation' || imported === 'action'
			? RAW_KINDS[imported]
			: undefined;
	}
	if (source === 'convex/server' && imported.endsWith('Generic')) return RAW_KINDS[imported];
	return undefined;
};

/** The `apps/api` directory a file under `…/convex/` belongs to. */
export const convexApiRoot = (filename: string): string | undefined => {
	let directory = dirname(filename);
	for (;;) {
		if (
			basename(directory) === 'convex' &&
			existsSync(join(directory, 'lib', 'authedFunctions.ts'))
		) {
			return dirname(directory);
		}
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
};

const tables = new Map<string, BuilderTable | Error>();

const KINDS = new Set(['query', 'mutation', 'action']);
const FLOORS = new Set(['member', 'role', 'identity', 'public']);

/** The classification table, as `CONVEX_BASE_BUILDERS='…'` in the shell library. */
const BASE_TABLE = /^CONVEX_BASE_BUILDERS='([^']*)'/mu;
const EXPORT = /^export const ([A-Za-z0-9_]+) =/u;
const COMPOSITION = /^(?:export )?const ([A-Za-z0-9_]+) = featureGated(?:Any)?\(/u;
const IDENTIFIER_PREFIX = /^[A-Za-z0-9_]*/u;

/** Every production `.ts` file under `directory`, in byte order (as `LC_ALL=C sort`). */
const sourceFiles = (directory: string): string[] => {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
		const path = join(entry.parentPath, entry.name);
		if (/\/(?:_generated|__tests__)\//u.test(path) || entry.name.endsWith('.test.ts')) continue;
		files.push(path);
	}
	return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};

/**
 * The derivation of apps/api/scripts/lib/convex-builders.sh, read from the same
 * inputs: its `CONVEX_BASE_BUILDERS` classification of the exports of
 * convex/lib/authedFunctions.ts, and every `(export )?const <name> =
 * featureGated(Any)?(<base>,` composition under convex/ (the base may sit on
 * the next line when the formatter wraps the call). A composition inherits its
 * base's kind and floor. Fails on an unclassified export, a row that is no
 * longer exported, a name composed from two different bases, or an unknown
 * base, exactly where the shell derivation fails.
 */
export const deriveBuilderTable = (apiRoot: string): BuilderTable => {
	const library = readFileSync(join(apiRoot, 'scripts', 'lib', 'convex-builders.sh'), 'utf8');
	const rows = BASE_TABLE.exec(library)?.[1];
	if (rows === undefined) throw new Error('CONVEX_BASE_BUILDERS not found in convex-builders.sh');
	const table = new Map<string, Builder>();
	for (const row of rows.split('\n')) {
		const [name, kind, floor] = row.trim().split(/\s+/u);
		if (!name || !kind || !floor || !KINDS.has(kind) || !FLOORS.has(floor)) {
			throw new Error(`unreadable CONVEX_BASE_BUILDERS row: ${JSON.stringify(row)}`);
		}
		table.set(name, { name, kind: kind as BuilderKind, floor: floor as BuilderFloor });
	}

	const convex = join(apiRoot, 'convex');
	const source = join(convex, 'lib', 'authedFunctions.ts');
	const exported = new Set<string>();
	for (const line of readFileSync(source, 'utf8').split('\n')) {
		const name = EXPORT.exec(line)?.[1];
		if (name === undefined) continue;
		exported.add(name);
		if (!table.has(name)) {
			throw new Error(
				`export ${name} of convex/lib/authedFunctions.ts is not classified in CONVEX_BASE_BUILDERS`
			);
		}
	}
	for (const name of table.keys()) {
		if (!exported.has(name)) {
			throw new Error(
				`CONVEX_BASE_BUILDERS lists ${name}, which convex/lib/authedFunctions.ts no longer exports`
			);
		}
	}

	const bases = new Map<string, { base: string; at: string }>();
	const compose = (name: string, base: string, at: string) => {
		const earlier = bases.get(name);
		if (earlier && earlier.base !== base) {
			throw new Error(
				`${at}: ${name} is composed from ${base} here and from ${earlier.base} in ${earlier.at}`
			);
		}
		if (!earlier) bases.set(name, { base, at });
	};
	for (const path of sourceFiles(convex)) {
		if (path === source) continue;
		const text = readFileSync(path, 'utf8');
		if (!/featureGated(?:Any)?\(/u.test(text)) continue;
		const lines = text.split('\n');
		let pending: { name: string; at: string } | undefined;
		for (const [index, line] of lines.entries()) {
			if (pending) {
				compose(pending.name, IDENTIFIER_PREFIX.exec(line.trimStart())?.[0] ?? '', pending.at);
				pending = undefined;
			}
			const name = COMPOSITION.exec(line)?.[1];
			if (name === undefined) continue;
			const at = `${relative(apiRoot, path)}:${index + 1}`;
			const base = IDENTIFIER_PREFIX.exec(line.slice(line.indexOf('(') + 1).trimStart())?.[0] ?? '';
			if (base === '') pending = { name, at };
			else compose(name, base, at);
		}
	}
	// A composition may wrap another composition: resolve until stable.
	for (let changed = true; changed;) {
		changed = false;
		for (const [name, { base }] of bases) {
			const resolved = table.get(base);
			if (!table.has(name) && resolved) {
				table.set(name, { name, kind: resolved.kind, floor: resolved.floor });
				changed = true;
			}
		}
	}
	for (const [name, { base, at }] of bases) {
		if (!table.has(name)) throw new Error(`${at}: ${name} composes unknown builder ${base}`);
	}
	return table;
};

/** The builder table for an `apps/api` root (derived once per lint process), or why there is none. */
export const builderTable = (apiRoot: string): BuilderTable | Error => {
	let result = tables.get(apiRoot);
	if (result === undefined) {
		try {
			result = deriveBuilderTable(apiRoot);
		} catch (error) {
			result = error instanceof Error ? error : new Error(String(error));
		}
		tables.set(apiRoot, result);
	}
	return result;
};

/**
 * The table for the file being linted. Reports once on the file and returns
 * `undefined` when the derivation fails; returns `undefined` silently for a
 * file outside any Convex tree.
 */
export const builderTableFor = (context: Context): BuilderTable | undefined => {
	const apiRoot = convexApiRoot(context.filename);
	if (apiRoot === undefined) return undefined;
	const table = builderTable(apiRoot);
	if (table instanceof Error) {
		context.report({
			loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
			message: `Cannot derive the Convex builder list (the inputs of apps/api/scripts/lib/convex-builders.sh): ${table.message}`,
		});
		return undefined;
	}
	return table;
};

/** The builder a callee resolves to, if any. */
const resolveBuilder = (
	context: Context,
	table: BuilderTable,
	callee: Node,
	depth = 0
): Builder | undefined => {
	const imported = importedThrough(context, callee);
	if (imported) {
		const raw = rawBuilderKind(imported.source, imported.name);
		if (raw) return { name: imported.name, kind: raw, floor: 'raw' };
		return table.get(imported.name);
	}
	const current = unwrap(callee);
	// A file-local composition (`const assistantQuery = featureGated(…)`) is in
	// the table under its own name, and a local alias (`const q = postboxQuery`)
	// is followed to what it aliases. A parameter or an unbound name is not a
	// builder.
	if (current?.type !== 'Identifier') return undefined;
	const binding = bindingOf(context, current);
	if (binding.type !== 'local' || binding.declaration?.type !== 'VariableDeclarator') {
		return undefined;
	}
	const own = table.get(current.name);
	if (own) return own;
	const init = unwrap(binding.declaration.init as AstNode);
	if (depth < 8 && (init?.type === 'Identifier' || init?.type === 'MemberExpression')) {
		return resolveBuilder(context, table, init, depth + 1);
	}
	return undefined;
};

interface RegisteredFunction {
	/** The name Convex registers it under. */
	name: string;
	/** Where to report: the exported name, or the call for `export default`. */
	nameNode: AstNode;
	builder: Builder;
	/** The builder call: everything lexically inside it is the definition. */
	call: AstNode;
	/** The top-level statement holding the definition (for opt-out comments). */
	statement: AstNode;
}

const builderCall = (
	context: Context,
	table: BuilderTable,
	init: Node
): { call: AstNode; builder: Builder } | undefined => {
	const call = unwrap(init);
	if (call?.type !== 'CallExpression') return undefined;
	const builder = resolveBuilder(context, table, call.callee as AstNode);
	return builder ? { call, builder } : undefined;
};

/**
 * Every function a module registers with a builder: a top-level
 * `export const x = builder(…)`, a top-level `const x = builder(…)` exported
 * later through `export { x }` / `export { x as y }`, and
 * `export default builder(…)`.
 */
export const registeredFunctions = (
	context: Context,
	table: BuilderTable,
	program: AstNode
): RegisteredFunction[] => {
	if (program.type !== 'Program') return [];
	const exportedAs = new Map<string, string[]>();
	for (const statement of program.body) {
		if (statement.type !== 'ExportNamedDeclaration' || statement.source) continue;
		for (const specifier of statement.specifiers) {
			if (specifier.local.type !== 'Identifier') continue;
			const exported =
				specifier.exported.type === 'Identifier'
					? specifier.exported.name
					: String(specifier.exported.value);
			exportedAs.set(specifier.local.name, [
				...(exportedAs.get(specifier.local.name) ?? []),
				exported,
			]);
		}
	}

	const found: RegisteredFunction[] = [];
	for (const statement of program.body) {
		if (statement.type === 'ExportDefaultDeclaration') {
			const match = builderCall(context, table, statement.declaration as AstNode);
			if (match) found.push({ name: 'default', nameNode: match.call, statement, ...match });
			continue;
		}
		const exported = statement.type === 'ExportNamedDeclaration';
		const declaration = exported ? statement.declaration : statement;
		if (declaration?.type !== 'VariableDeclaration') continue;
		for (const declarator of declaration.declarations) {
			if (declarator.id.type !== 'Identifier') continue;
			const names = exported ? [declarator.id.name] : (exportedAs.get(declarator.id.name) ?? []);
			if (names.length === 0) continue;
			const match = builderCall(context, table, declarator.init as AstNode);
			if (!match) continue;
			for (const name of names) {
				found.push({ name, nameNode: declarator.id, statement, ...match });
			}
		}
	}
	return found;
};
