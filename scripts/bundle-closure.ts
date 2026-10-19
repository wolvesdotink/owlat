/**
 * Reading a finished `nuxt build` the way the bundle checks measure it.
 *
 * `check-bundle-budget.ts` (the entry gate) and `report-bundle-closures.ts`
 * (the report-only route and deferred-feature view) share these rules so both
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
	return [...found].sort();
}

export function staticImports(publicDir: string, file: string): string[] {
	return matches(readFileSync(join(publicDir, file), 'utf8'), [FROM_IMPORT, BARE_IMPORT]);
}

export function dynamicImports(publicDir: string, file: string): string[] {
	return matches(readFileSync(join(publicDir, file), 'utf8'), [DYNAMIC_IMPORT]);
}

/** The root and every file it reaches through static imports, sorted by name. */
export function staticClosure(publicDir: string, root: string): string[] {
	const closure = new Set<string>();
	const stack = [root];
	while (stack.length > 0) {
		const file = stack.pop() as string;
		if (closure.has(file) || !existsSync(join(publicDir, file))) continue;
		closure.add(file);
		stack.push(...staticImports(publicDir, file));
	}
	return [...closure].sort();
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
