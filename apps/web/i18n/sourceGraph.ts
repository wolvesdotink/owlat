/**
 * Which app source file can put which other file on screen: the build-time
 * graph the area catalogs (./catalogAreas.ts) are cut along.
 *
 * A file reaches another through an explicit import (`~/`, `~~/`, `@/` or
 * relative, static or `import()`), through a Nuxt auto-imported component
 * (`<PostboxReader>`, `<postbox-reader>`, `LazyPostboxReader`, a
 * `resolveComponent('PostboxReader')` string), or through an auto-imported
 * composable or util (`useFoo()` with no import line at all).
 *
 * Every mistake here has to fall on the safe side. An edge the scan invents
 * only makes a file reachable from one more place, which keeps its messages in
 * more chunks (or in the boot catalog). An edge the scan misses could leave a
 * message out of the chunk its screen loads, so the matching is deliberately
 * loose: any identifier or kebab-case word anywhere in a file, comments and
 * strings included, counts as a use.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, normalize, relative } from 'node:path';

export interface SourceGraph {
	/** Absolute path → source text, for every scanned `.vue` / `.ts` file. */
	readonly sources: ReadonlyMap<string, string>;
	/** Absolute path → the files it can render or run. */
	readonly edges: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface SourceRoots {
	/** The app's `srcDir` (`apps/web/app`). */
	readonly appDir: string;
	/** The app's `rootDir` (`apps/web`), for `~~/` imports. */
	readonly rootDir: string;
	/** Layer roots whose `components/`, `composables/` and `utils/` Nuxt merges in. */
	readonly layerDirs: readonly string[];
}

/** Tests and build output are not app code; `node_modules` is not ours. */
const SKIP_DIRS = new Set(['node_modules', '__tests__', '.nuxt', '.output', 'dist']);

export function listSourceFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) found.push(...listSourceFiles(path));
		else if (/\.(?:vue|ts)$/.test(entry) && !entry.endsWith('.d.ts')) found.push(path);
	}
	return found;
}

/** A port of `scule`'s `splitByCase`, which Nuxt names components with. */
export function splitByCase(value: string): string[] {
	const parts: string[] = [];
	if (!value) return parts;
	const isUpper = (char: string) => (/\d/.test(char) ? undefined : char !== char.toLowerCase());
	let buff = '';
	let previousUpper: boolean | undefined;
	let previousSplitter: boolean | undefined;
	for (const char of value) {
		if (['-', '_', '/', '.'].includes(char)) {
			parts.push(buff);
			buff = '';
			previousUpper = undefined;
			continue;
		}
		const upper = isUpper(char);
		if (previousSplitter === false) {
			if (previousUpper === false && upper === true) {
				parts.push(buff);
				buff = char;
				previousUpper = upper;
				continue;
			}
			if (previousUpper === true && upper === false && buff.length > 1) {
				parts.push(buff.slice(0, -1));
				buff = buff.slice(-1) + char;
				previousUpper = upper;
				continue;
			}
		}
		buff += char;
		previousUpper = upper;
		previousSplitter = false;
	}
	parts.push(buff);
	return parts;
}

/**
 * The name Nuxt registers a component file under (its `resolveComponentNameSegments`),
 * lower-cased with the separators dropped so `PostboxReader` and
 * `postbox-reader` compare equal. `relativePath` is relative to `components/`.
 */
export function componentKey(relativePath: string): string {
	const prefixParts = splitByCase(dirname(relativePath) === '.' ? '' : dirname(relativePath));
	let fileName = basename(relativePath, extname(relativePath)).replace(
		/(?:\.(?:client|server))?(?:\.global|\.island)*$/,
		''
	);
	if (fileName.toLowerCase() === 'index') fileName = '';
	const fileParts = splitByCase(fileName);
	const fileContent = fileParts.join('/').toLowerCase();
	const nameParts = prefixParts.flatMap((part) => splitByCase(part));
	const matched: string[] = [];
	for (let index = prefixParts.length - 1; index >= 0; index--) {
		const part = prefixParts[index]!;
		matched.unshift(...splitByCase(part).map((p) => p.toLowerCase()));
		const matchedContent = matched.join('/');
		if (
			fileContent === matchedContent ||
			fileContent.startsWith(`${matchedContent}/`) ||
			(part.toLowerCase() === fileContent &&
				prefixParts[index + 1] !== undefined &&
				part === prefixParts[index + 1])
		) {
			nameParts.length = index;
		}
	}
	return [...nameParts, ...fileParts].join('').toLowerCase();
}

const EXPORTED_VALUE =
	/export\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s*([A-Za-z_$][\w$]*)/g;
const EXPORT_LIST = /export\s*\{([^}]*)\}/g;
const EXPORT_STAR = /export\s*\*\s*from\s*['"]([^'"]+)['"]/g;
const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const KEBAB_WORD = /[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g;

function resolveImport(roots: SourceRoots, from: string, spec: string): string | undefined {
	let base: string;
	if (spec.startsWith('~~/')) base = join(roots.rootDir, spec.slice(3));
	else if (spec.startsWith('~/') || spec.startsWith('@/')) base = join(roots.appDir, spec.slice(2));
	else if (spec.startsWith('.')) base = normalize(join(dirname(from), spec));
	else return undefined;
	for (const candidate of [base, `${base}.ts`, `${base}.vue`, join(base, 'index.ts')]) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return undefined;
}

/**
 * Every module under an auto-import dir. Nuxt only auto-imports the top level,
 * `<dir>/index.ts` and whatever nuxt.config `imports.dirs` adds; treating every
 * nested file as auto-imported as well can only add edges, and it keeps this
 * scan correct when that config grows a folder.
 */
const autoImportFiles = (dir: string) =>
	listSourceFiles(dir).filter((file) => file.endsWith('.ts'));

function exportedNames(roots: SourceRoots, file: string, source: string, depth = 0): string[] {
	const names = [...source.matchAll(EXPORTED_VALUE)].map((m) => m[1]!);
	for (const match of source.matchAll(EXPORT_LIST)) {
		for (const item of match[1]!.split(',')) {
			const name = item
				.trim()
				.split(/\s+as\s+/)
				.pop()
				?.trim();
			if (name && name !== 'type') names.push(name.replace(/^type\s+/, ''));
		}
	}
	// A default export is auto-imported under the file's (or an index's folder's) name.
	if (/export\s+default\b/.test(source)) {
		names.push(basename(file, '.ts'), basename(dirname(file)));
	}
	if (depth < 3) {
		for (const match of source.matchAll(EXPORT_STAR)) {
			const target = resolveImport(roots, file, match[1]!);
			if (target) {
				names.push(...exportedNames(roots, target, readFileSync(target, 'utf8'), depth + 1));
			}
		}
	}
	return names;
}

/** Every identifier and kebab-case word in a file, lower-cased, with and without a `Lazy` prefix. */
function wordsOf(source: string): Set<string> {
	const words = new Set<string>();
	const add = (word: string) => {
		const key = word.replaceAll('-', '').toLowerCase();
		words.add(key);
		if (key.startsWith('lazy')) words.add(key.slice(4));
	};
	for (const match of source.matchAll(IDENTIFIER)) add(match[0]);
	for (const match of source.matchAll(KEBAB_WORD)) add(match[0]);
	return words;
}

export function buildSourceGraph(roots: SourceRoots): SourceGraph {
	const scanDirs = [roots.appDir, ...roots.layerDirs];
	const sources = new Map<string, string>();
	for (const dir of scanDirs) {
		for (const file of listSourceFiles(dir)) sources.set(file, readFileSync(file, 'utf8'));
	}

	// Lower-cased component name → files registered under it.
	const components = new Map<string, Set<string>>();
	for (const dir of scanDirs) {
		const componentsDir = join(dir, 'components');
		for (const file of listSourceFiles(componentsDir)) {
			if (!file.endsWith('.vue')) continue;
			const key = componentKey(relative(componentsDir, file));
			components.set(key, (components.get(key) ?? new Set()).add(file));
		}
	}

	// Lower-cased auto-imported identifier → files exporting it.
	const autoImports = new Map<string, Set<string>>();
	const importDirs = scanDirs.flatMap((dir) => [join(dir, 'composables'), join(dir, 'utils')]);
	for (const dir of importDirs) {
		for (const file of autoImportFiles(dir)) {
			for (const name of exportedNames(roots, file, readFileSync(file, 'utf8'))) {
				const key = name.toLowerCase();
				autoImports.set(key, (autoImports.get(key) ?? new Set()).add(file));
			}
		}
	}

	const edges = new Map<string, Set<string>>();
	for (const [file, source] of sources) {
		const targets = new Set<string>();
		for (const match of source.matchAll(IMPORT_SPEC)) {
			const target = resolveImport(roots, file, match[1]!);
			if (target) targets.add(target);
		}
		for (const word of wordsOf(source)) {
			for (const target of components.get(word) ?? []) targets.add(target);
			for (const target of autoImports.get(word) ?? []) targets.add(target);
		}
		targets.delete(file);
		edges.set(file, targets);
	}
	return { sources, edges };
}

/** Every file reachable from `roots`, the roots included. */
export function reachableFrom(graph: SourceGraph, roots: Iterable<string>): Set<string> {
	const seen = new Set(roots);
	const stack = [...seen];
	while (stack.length > 0) {
		for (const next of graph.edges.get(stack.pop()!) ?? []) {
			if (!seen.has(next)) {
				seen.add(next);
				stack.push(next);
			}
		}
	}
	return seen;
}
