import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { RegistryEntry } from '../maintenance/derivedFields/types';

/**
 * The source scan behind the derived-field registry gate
 * (`derivedFieldRegistry.test.ts`): every `AGGREGATED` / `COUNTER [<id>]` label
 * in the backend source, and what is wrong with each one against the registry.
 * Pure over `{ path, text }` so the gate's own tests can feed it fixtures.
 */

export interface SourceFile {
	/** Path relative to `apps/api/convex`, `/`-separated. */
	readonly path: string;
	readonly text: string;
}

export interface Label {
	readonly path: string;
	/** 1-based line of the label. */
	readonly line: number;
	readonly kind: 'AGGREGATED' | 'COUNTER';
	readonly id: string | undefined;
}

// `AGGREGATED` is reserved for the label, so a bare one is an unregistered
// label. `COUNTER` is ordinary upper-case prose too, so only `COUNTER [<id>]`
// is one.
const LABEL = /\b(AGGREGATED|COUNTER)\b(?:\s*\[([A-Za-z][A-Za-z0-9_]*)\])?/g;

const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
const TABLE_DECLARATION = /^\s*(?:(\w+)\s*:|(?:export )?const (\w+)\s*=)\s*defineTable\((\w+)?/;
const OBJECT_DECLARATION = /^(?:export )?const (\w+)(?:\s*:[^=]+)?\s*=\s*\{/;
const DECLARED_KEY = /^\s*(?:\.\.\.(\w+)|(\w+)\s*:)/;
const STRING_LITERAL = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

/** Schema and shared-validator files, where a label must sit on the fields it names. */
function isDeclarationFile(path: string): boolean {
	return path.startsWith('schema/') || path.startsWith('lib/validators/');
}

function isInComment(line: string, index: number): boolean {
	if (COMMENT_LINE.test(line)) return true;
	const slashes = line.indexOf('//');
	return slashes !== -1 && slashes < index;
}

export function findLabels(file: SourceFile): Label[] {
	const labels: Label[] = [];
	for (const [index, line] of file.text.split('\n').entries()) {
		for (const match of line.matchAll(LABEL)) {
			const kind = match[1] as Label['kind'];
			const id = match[2];
			if (!isInComment(line, match.index)) continue;
			if (kind === 'COUNTER' && id === undefined) continue;
			labels.push({ path: file.path, line: index + 1, kind, id });
		}
	}
	return labels;
}

/**
 * What a key is declared inside: a table (`name: defineTable(`) or a named
 * object of validators (`const name = {`), whichever is innermost.
 */
interface Root {
	readonly kind: 'table' | 'object';
	readonly name: string;
}

/** One key or spread declared on a line, with the object keys that contain it. */
interface Declaration {
	readonly root: Root | undefined;
	/** Keys between the root and this declaration (`outbound` for `outbound.state`). */
	readonly parents: readonly string[];
	readonly key: string;
	readonly isSpread: boolean;
	/** The line declares the table `key` itself. */
	readonly isTable: boolean;
}

/** A named object spread into a table or another object, or passed whole to `defineTable`. */
interface Use {
	readonly name: string;
	readonly root: Root | undefined;
	readonly parents: readonly string[];
}

interface FileShape {
	/** By 0-based line. */
	readonly declarations: ReadonlyMap<number, Declaration>;
	readonly uses: readonly Use[];
}

/** The line without its comment and string contents, for bracket counting. */
function codeOf(line: string): string {
	if (COMMENT_LINE.test(line)) return '';
	const code = line.replace(STRING_LITERAL, "''");
	const slashes = code.indexOf('//');
	return slashes === -1 ? code : code.slice(0, slashes);
}

function bracketBalance(code: string): number {
	let balance = 0;
	for (const char of code) {
		if (char === '(' || char === '{' || char === '[') balance += 1;
		else if (char === ')' || char === '}' || char === ']') balance -= 1;
	}
	return balance;
}

/**
 * Every key declared in a schema or validator file, with its full path inside
 * its table or named object, found by following the brackets: a key whose
 * line opens a bracket contains what is declared until that bracket closes.
 */
function fileShape(text: string): FileShape {
	const declarations = new Map<number, Declaration>();
	const uses: Use[] = [];
	const scopes: Array<{ depth: number; key?: string; root?: Root }> = [];
	let depth = 0;
	for (const [index, line] of text.split('\n').entries()) {
		const code = codeOf(line);
		let rootAt = scopes.length - 1;
		while (rootAt >= 0 && scopes[rootAt]?.root === undefined) rootAt -= 1;
		const root = scopes[rootAt]?.root;
		const parents = scopes.slice(rootAt + 1).flatMap((scope) => (scope.key ? [scope.key] : []));
		const table = TABLE_DECLARATION.exec(code);
		const object = table ? null : OBJECT_DECLARATION.exec(code);
		const key = DECLARED_KEY.exec(code);
		if (key) {
			declarations.set(index, {
				root,
				parents,
				key: (key[1] ?? key[2]) as string,
				isSpread: key[1] !== undefined,
				isTable: table !== null,
			});
			if (key[1] !== undefined) uses.push({ name: key[1], root, parents });
		}
		const tableName = table ? (table[1] ?? table[2]) : undefined;
		if (tableName && table?.[3]) {
			uses.push({ name: table[3], root: { kind: 'table', name: tableName }, parents: [] });
		}

		const balance = bracketBalance(code);
		depth += balance;
		while ((scopes[scopes.length - 1]?.depth ?? -1) > depth) scopes.pop();
		if (balance <= 0) continue;
		if (tableName) scopes.push({ depth, root: { kind: 'table', name: tableName } });
		else if (object) scopes.push({ depth, root: { kind: 'object', name: object[1] as string } });
		else if (key && key[2] !== undefined) scopes.push({ depth, key: key[2] });
		else scopes.push({ depth });
	}
	return { declarations, uses };
}

/** Where a declaration ends up: the table, and the path of keys inside it. */
interface Location {
	readonly table: string;
	readonly prefix: readonly string[];
}

/** Every table position a named object is spread into, through other objects too. */
function locateObject(
	name: string,
	uses: readonly Use[],
	seen: ReadonlySet<string> = new Set()
): Location[] {
	if (seen.has(name)) return [];
	const inner = new Set([...seen, name]);
	return uses
		.filter((use) => use.name === name)
		.flatMap((use) => locate(use.root, use.parents, uses, inner));
}

function locate(
	root: Root | undefined,
	parents: readonly string[],
	uses: readonly Use[],
	seen?: ReadonlySet<string>
): Location[] {
	if (!root) return [];
	if (root.kind === 'table') return [{ table: root.name, prefix: parents }];
	return locateObject(root.name, uses, seen).map((outer) => ({
		table: outer.table,
		prefix: [...outer.prefix, ...parents],
	}));
}

/** The first declaration after the comment block holding line `line` (1-based). */
function nextDeclaration(
	lines: readonly string[],
	shape: FileShape,
	line: number
): Declaration | undefined {
	// A trailing comment labels the declaration on its own line.
	if (!COMMENT_LINE.test(lines[line - 1] ?? '')) {
		const own = shape.declarations.get(line - 1);
		if (own) return own;
	}
	for (let i = line; i < lines.length; i++) {
		const text = lines[i] ?? '';
		if (text.trim() === '' || COMMENT_LINE.test(text)) continue;
		return shape.declarations.get(i);
	}
	return undefined;
}

/** What is wrong with a label on `declaration` for `entry`, if anything. */
function placementProblem(
	entry: RegistryEntry,
	declaration: Declaration | undefined,
	uses: readonly Use[]
): string | undefined {
	if (!declaration) return `labels \`?\`, not one of its fields`;
	if (declaration.isTable && declaration.key === entry.table) return undefined;
	const locations = locate(declaration.root, declaration.parents, uses);
	const inTable = locations.filter((location) => location.table === entry.table);
	if (inTable.length === 0) {
		const where = [...new Set(locations.map((location) => location.table))].join(', ') || '?';
		return `sits in table ${where}, not ${entry.table}`;
	}
	if (declaration.isSpread) {
		const isOwnSpread =
			entry.spread === declaration.key &&
			inTable.some((location) =>
				entry.fields.every((field) => field.startsWith(prefixOf(location.prefix)))
			);
		return isOwnSpread ? undefined : `labels \`...${declaration.key}\`, not one of its fields`;
	}
	const paths = inTable.map((location) => [...location.prefix, declaration.key].join('.'));
	if (paths.some((path) => entry.fields.includes(path))) return undefined;
	return `labels \`${paths[0]}\`, not one of its fields`;
}

function prefixOf(segments: readonly string[]): string {
	return segments.length === 0 ? '' : `${segments.join('.')}.`;
}

/** Every problem with the labels in `files`, as readable lines; empty when clean. */
export function labelViolations(
	files: readonly SourceFile[],
	registry: readonly RegistryEntry[]
): string[] {
	const byId = new Map(registry.map((entry) => [entry.id, entry]));
	const shapes = new Map(
		files
			.filter((file) => isDeclarationFile(file.path))
			.map((file) => [file.path, fileShape(file.text)])
	);
	const uses = [...shapes.values()].flatMap((shape) => shape.uses);
	const violations: string[] = [];
	const used = new Set<string>();
	for (const file of files) {
		const lines = file.text.split('\n');
		for (const label of findLabels(file)) {
			const where = `${label.path}:${label.line}`;
			if (label.id === undefined) {
				violations.push(`${where}: AGGREGATED label without a registry id`);
				continue;
			}
			const entry = byId.get(label.id);
			if (!entry) {
				violations.push(`${where}: ${label.kind} [${label.id}] is not in the registry`);
				continue;
			}
			used.add(entry.id);
			const expectedKind = entry.kind === 'derived' ? 'AGGREGATED' : 'COUNTER';
			if (label.kind !== expectedKind) {
				violations.push(`${where}: [${entry.id}] is registered as ${expectedKind}`);
				continue;
			}
			const shape = shapes.get(label.path);
			if (!shape) continue;
			const problem = placementProblem(entry, nextDeclaration(lines, shape, label.line), uses);
			if (problem) violations.push(`${where}: [${entry.id}] ${problem}`);
		}
	}
	for (const entry of registry) {
		if (!used.has(entry.id)) violations.push(`registry entry ${entry.id} labels no field`);
	}
	return violations;
}

const SKIPPED_DIRECTORIES = new Set(['_generated', '__tests__', 'node_modules']);

/**
 * The backend source the labels live in. The registry module itself is left
 * out: it describes the labels rather than carrying them.
 */
export function backendSources(root: string): SourceFile[] {
	const files: SourceFile[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				if (!SKIPPED_DIRECTORIES.has(name)) walk(full);
				continue;
			}
			if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.d.ts')) continue;
			const path = relative(root, full).split('\\').join('/');
			if (path.startsWith('maintenance/derivedFields/')) continue;
			files.push({ path, text: readFileSync(full, 'utf8') });
		}
	};
	walk(root);
	return files;
}
