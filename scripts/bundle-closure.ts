/**
 * Reading a finished `nuxt build` the way the bundle checks measure it.
 *
 * `check-bundle-budget.ts` (the entry gate) and `report-bundle-closures.ts`
 * (the route and deferred-feature budgets) share these rules so both
 * count the same bytes: the entry file name comes from the Nitro renderer, a
 * closure follows STATIC imports only (`import()` is a lazy chunk and starts its
 * own closure), and every file is gzipped at level 9.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

export interface WebBuild {
	outputDir: string;
	publicDir: string;
	/** The entry chunk, a file name inside `publicDir`. */
	entry: string;
}

/** Exits with status 2 and the tool's name when the output is not a server build. */
export function readWebBuild(tool: string, outputArg: string | undefined): WebBuild {
	const workspace = resolve(import.meta.dirname, '..');
	const outputDir = resolve(outputArg ?? join(workspace, 'apps/web/.output'));
	const publicDir = join(outputDir, 'public/_nuxt');
	const rendererPath = join(outputDir, 'server/chunks/routes/renderer.mjs');

	if (!existsSync(rendererPath) || !existsSync(publicDir)) {
		console.error(
			`${tool}: no server build at ${outputDir}.\n` +
				'Run `nuxt build` in apps/web first (a `nuxt generate` output has no renderer to read the entry from).'
		);
		process.exit(2);
	}

	const entry = /entryFileName = "([^"]+)"/.exec(readFileSync(rendererPath, 'utf8'))?.[1];
	if (!entry) {
		console.error(`${tool}: no entryFileName in ${rendererPath}.`);
		process.exit(2);
	}
	if (!existsSync(join(publicDir, entry))) {
		console.error(`${tool}: entry ${entry} is missing from ${publicDir}.`);
		process.exit(2);
	}
	return { outputDir, publicDir, entry };
}

/** `from "./x.js"` and bare `import "./x.js"`; never `import("./x.js")`. */
const FROM_IMPORT = /\bfrom\s*["']\.\/([\w\-.]+\.js)["']/g;
const BARE_IMPORT = /(?:^|[;\n}])\s*import\s*["']\.\/([\w\-.]+\.js)["']/g;
/** `import("./x.js")`; Vite's minified output quotes it with backticks. */
const DYNAMIC_IMPORT = /\bimport\(\s*["'`]\.\/([\w\-.]+\.js)["'`]\s*\)/g;

function matches(source: string, patterns: RegExp[]): string[] {
	const found = new Set<string>();
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) found.add(match[1] as string);
	}
	return [...found];
}

export function staticImports(publicDir: string, file: string): string[] {
	return matches(readFileSync(join(publicDir, file), 'utf8'), [FROM_IMPORT, BARE_IMPORT]);
}

export function dynamicImports(publicDir: string, file: string): string[] {
	return matches(readFileSync(join(publicDir, file), 'utf8'), [DYNAMIC_IMPORT]);
}

/**
 * The root and every file it reaches through static imports, in walk order.
 * The entry budget lists equal-sized files in this order; the report sorts.
 */
export function staticClosure(publicDir: string, root: string): string[] {
	const closure = new Set<string>();
	const stack = [root];
	while (stack.length > 0) {
		const file = stack.pop() as string;
		if (closure.has(file) || !existsSync(join(publicDir, file))) continue;
		closure.add(file);
		stack.push(...staticImports(publicDir, file));
	}
	return [...closure];
}

export interface FileSize {
	file: string;
	raw: number;
	gz: number;
}

export function measure(publicDir: string, file: string): FileSize {
	const bytes = readFileSync(join(publicDir, file));
	return { file, raw: bytes.length, gz: gzipSync(bytes, { level: 9 }).length };
}

export const kb = (bytes: number) => (bytes / 1024).toFixed(1);

/** Which part of the closure report a budget line covers. */
export type ClosureKind = 'route' | 'deferred';

/** Budgets in KiB, keyed as the closure report keys its rows. */
export type ClosureBudgets = Record<ClosureKind, Map<string, number>>;

/** `route 455 pages/x.vue`: kind, whole KiB, then the key to the end of the line. */
const BUDGET_LINE = /^(route|deferred)\s+(\d+)\s+(\S.*?)\s*$/;

/**
 * Parses `scripts/bundle-closure-budgets.txt`. Blank lines and `#` comments are
 * skipped; a malformed or repeated line throws with its line number, because a
 * line the parser dropped would silently unbudget its closure.
 */
export function parseClosureBudgets(text: string): ClosureBudgets {
	const budgets: ClosureBudgets = { route: new Map(), deferred: new Map() };
	for (const [index, line] of text.split('\n').entries()) {
		if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
		const match = BUDGET_LINE.exec(line);
		if (!match) throw new Error(`line ${index + 1} is not "<route|deferred> <KiB> <key>": ${line}`);
		const [, kind, size, key] = match as unknown as [string, ClosureKind, string, string];
		if (budgets[kind].has(key)) throw new Error(`line ${index + 1} repeats ${kind} ${key}`);
		budgets[kind].set(key, Number(size));
	}
	return budgets;
}

/**
 * The budget a closure of `gzipBytes` starts with: the size plus the larger of
 * 10% and 2 KiB, rounded up to a whole KiB. The 2 KiB floor keeps a small
 * chunk from failing on a few added lines of copy or one more icon.
 */
export function suggestedBudgetKiB(gzipBytes: number): number {
	return Math.ceil((gzipBytes + Math.max(gzipBytes * 0.1, 2048)) / 1024);
}
