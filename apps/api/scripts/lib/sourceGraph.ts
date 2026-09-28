/**
 * The source-reading helpers the bun wiring checks share
 * (`check-entry-wiring.ts`, `check-gate-input-wiring.ts`,
 * `check-transport-outcome-wiring.ts`, `check-kind-literal-custody.ts`).
 *
 * Each check proves that production code is wired up by reading the SOURCE.
 * When each one carried its own file walker, comment stripper and import
 * resolver, they disagreed: one walked `_generated/` and stray test files,
 * one kept a trailing comment as code, one could not follow an import through
 * a folder `index.ts`. A fix to one parser never reached the others. The one
 * policy for each lives here.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/**
 * Directories no walk enters. Tests are the fabricated callers these checks
 * exist to see past, `_generated` names every function without calling one,
 * and the rest are dependencies or build output (copies of the source).
 * `.well-known` is a live Nuxt route directory, so only these names are
 * skipped, never every dot-prefixed directory.
 */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
	'__tests__',
	'_generated',
	'node_modules',
	'dist',
	'.nuxt',
	'.output',
	'build',
	'coverage',
]);

/** `*.test.ts` / `*.spec.ts`: a test file outside a `__tests__` folder. */
export const isTestFile = (name: string): boolean => /\.(?:test|spec)\.ts$/.test(name);

export interface ProductionModuleOptions {
	/** File name endings to collect; `.ts` alone by default. */
	readonly extensions?: readonly string[];
}

/** Every production source file under `root`, as sorted absolute paths. */
export function productionModules(
	root: string,
	{ extensions = ['.ts'] }: ProductionModuleOptions = {}
): string[] {
	const walk = (dir: string, found: string[]): string[] => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(full, found);
			} else if (
				!isTestFile(entry.name) &&
				extensions.some((extension) => entry.name.endsWith(extension))
			) {
				found.push(full);
			}
		}
		return found;
	};
	return existsSync(root) ? walk(root, []).sort() : [];
}

/**
 * Source text with its comments removed, in this order:
 *
 *   1. `<!-- -->`, so a whole HTML comment in a `.vue` template is gone before
 *      the `//` pass can eat its terminator;
 *   2. `/* *\/` block comments;
 *   3. `//` line comments, unless the `//` follows a `:`, so a `scheme://host`
 *      inside a string survives while a trailing `// note` after code does not.
 *
 * A comment is prose: a check that read it as code would credit a module with
 * a caller, an emitter or a declaration it only mentions.
 */
export function stripComments(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const toPosix = (path: string): string => path.split('\\').join('/');

/** Each file's comment-stripped source, keyed by its POSIX path relative to `root`. */
export function sourceMap(root: string, files: readonly string[]): Map<string, string> {
	return new Map(
		files.map((file) => [toPosix(relative(root, file)), stripComments(readFileSync(file, 'utf8'))])
	);
}

/** A value import: `import <clause> from '<specifier>';` (never `import type`). */
export const IMPORT_DECLARATION = /^import\s+(?!type\b)([\s\S]*?)\s*from\s*'([^']+)';/gm;

/**
 * Every declaration that loads another module at runtime:
 * `import <clause> from`, a side-effect `import '<specifier>'` and a
 * re-export `export <clause> from`. `import type` / `export type` are
 * erased by the compiler; so is a clause whose every specifier is an
 * inline `type` (`import { type A } from`).
 */
const VALUE_EDGE = /^(import|export)\s+(?:(?!type\b)([^;'"]*?)\s*from\s*)?['"]([^'"]+)['"]\s*;?/gm;

/** The specifiers `source` (comments already stripped) loads at runtime, in order. */
export function valueImportSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	for (const match of source.matchAll(VALUE_EDGE)) {
		const [, keyword, clause, specifier] = match;
		if (specifier === undefined) continue;
		if (clause === undefined) {
			// `import 'x'` loads x; a bare `export 'x'` is not a declaration.
			if (keyword === 'import') specifiers.push(specifier);
			continue;
		}
		if (clause.startsWith('*') || boundNames(clause).length > 0) specifiers.push(specifier);
	}
	return specifiers;
}

/**
 * The names an import or export clause binds, both sides of an `as` kept
 * (`{ a as b }` yields `a` and `b`), and inline `type` specifiers dropped.
 */
export function boundNames(clause: string): string[] {
	return clause
		.replace(/[{}]/g, ' ')
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0 && !/^type\s/.test(entry))
		.flatMap((entry) => entry.split(/\s+as\s+/).map((part) => part.trim()))
		.filter((entry) => entry.length > 0);
}

/** The value names a module exports: declarations and `export { … }` clauses. */
export function valueExports(source: string): Set<string> {
	const names = new Set<string>();
	const declared = /export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/g;
	for (const match of source.matchAll(declared)) {
		if (match[1] !== undefined) names.add(match[1]);
	}
	for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
		for (const name of boundNames(match[1] ?? '')) names.add(name);
	}
	return names;
}

/**
 * Both files a relative specifier can name, relative to the same root as
 * `from`: `./seedDemo` is `seedDemo.ts` or `seedDemo/index.ts`. A `.js`
 * extension is dropped first; a bare package specifier resolves to nothing.
 */
export function resolveRelative(from: string, specifier: string): string[] {
	if (!specifier.startsWith('.')) return [];
	const base = toPosix(join(dirname(from), specifier.replace(/\.js$/, '')));
	return [`${base}.ts`, `${base}/index.ts`];
}

export interface Checker {
	/** Record `message` as a failure unless `condition` holds. */
	check(condition: boolean, message: string): void;
	/** Record `message` followed by `items` as a failure unless `items` is empty. */
	expectEmpty(items: readonly string[], message: string): void;
	readonly failures: readonly string[];
	/** Print every failure and exit 1, or print `<label>: OK (<detail>)`. */
	report(label: string, detail?: string): void;
}

export function createChecker(): Checker {
	const failures: string[] = [];
	return {
		check(condition, message) {
			if (!condition) failures.push(message);
		},
		expectEmpty(items, message) {
			if (items.length > 0) failures.push(`${message}\n  ${items.join('\n  ')}`);
		},
		failures,
		report(label, detail) {
			if (failures.length > 0) {
				for (const failure of failures) console.error(`FAIL: ${failure}`);
				process.exit(1);
			}
			console.info(`${label}: OK${detail === undefined ? '' : ` (${detail})`}`);
		},
	};
}
