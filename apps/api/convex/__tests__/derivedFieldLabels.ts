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
const TABLE_DECLARATION = /^(?:\t(\w+): defineTable\(|(?:export )?const (\w+) = defineTable\()/;
const DECLARED_KEY = /^\s*(?:\.\.\.(\w+)|(\w+)\s*:)/;

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

/** The first key declared after the comment block holding line `line` (1-based). */
function nextDeclaredKey(lines: readonly string[], line: number): string | undefined {
	const own = lines[line - 1] ?? '';
	// A trailing comment labels the declaration on its own line.
	if (!COMMENT_LINE.test(own)) {
		const key = DECLARED_KEY.exec(own);
		if (key) return key[1] ?? key[2];
	}
	for (let i = line; i < lines.length; i++) {
		const text = lines[i] ?? '';
		if (text.trim() === '' || COMMENT_LINE.test(text)) continue;
		const key = DECLARED_KEY.exec(text);
		return key ? (key[1] ?? key[2]) : undefined;
	}
	return undefined;
}

/** The table whose `defineTable` body contains line `line`, if any. */
function enclosingTable(lines: readonly string[], line: number): string | undefined {
	for (let i = line - 1; i >= 0; i--) {
		const match = TABLE_DECLARATION.exec(lines[i] ?? '');
		if (match) return match[1] ?? match[2];
	}
	return undefined;
}

function leaf(path: string): string {
	return path.slice(path.lastIndexOf('.') + 1);
}

/** Every problem with the labels in `files`, as readable lines; empty when clean. */
export function labelViolations(
	files: readonly SourceFile[],
	registry: readonly RegistryEntry[]
): string[] {
	const byId = new Map(registry.map((entry) => [entry.id, entry]));
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
			if (!isDeclarationFile(label.path)) continue;
			const key = nextDeclaredKey(lines, label.line);
			const allowed = new Set([...entry.fields.map(leaf), ...(entry.spread ? [entry.spread] : [])]);
			if (key === entry.table) continue;
			if (key === undefined || !allowed.has(key)) {
				violations.push(`${where}: [${entry.id}] labels \`${key ?? '?'}\`, not one of its fields`);
				continue;
			}
			const table = enclosingTable(lines, label.line);
			if (label.path.startsWith('schema/') && table !== entry.table) {
				violations.push(
					`${where}: [${entry.id}] sits in table ${table ?? '?'}, not ${entry.table}`
				);
			}
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
