/**
 * Entry-bundle budget for the built web app.
 *
 * Every page, the sign-in page included, downloads and parses the entry chunk
 * and everything it imports statically before Vue can mount. That closure is
 * what the 2026-09-29 performance audit measured (438 KB gzip at v0.6.4, about
 * 190 KB of it the email builder that only the editors use), and nothing kept
 * it from growing back: one eager import in a plugin or the dashboard layout
 * pulls a whole feature into it and no test notices.
 *
 * This reads a finished `nuxt build` the same way the audit did: the entry file
 * name comes from the Nitro renderer, the walk follows STATIC imports only
 * (`import()` is a lazy chunk and stays out), and every file is gzipped at level
 * 9. The run fails when the closure's gzip total is over GZIP_BUDGET_KB.
 *
 * Lower the budget when a change shrinks the entry for good, so the room it
 * freed cannot be spent silently. Raising it needs a reason in the commit.
 *
 * Usage: bun scripts/check-bundle-budget.ts [path/to/.output]
 *   (defaults to apps/web/.output; CI copies the output out of the web image)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * Gzip budget for the entry closure, in KiB (1024 bytes).
 *
 * First set from this script's own reading, 230.7 KB, after the boot-path items
 * of the performance plan (1.7, 2.7, A8-A10) landed, plus about 5% headroom
 * (242). Raised on 2026-10-03 the same way, from 241.8 KB plus about 5%: the
 * entry had grown to within 0.2 KB of the old budget as features landed, so
 * the next eager addition would have failed.
 */
const GZIP_BUDGET_KB = 254;

const workspace = resolve(import.meta.dirname, '..');
const outputDir = resolve(process.argv[2] ?? join(workspace, 'apps/web/.output'));
const publicDir = join(outputDir, 'public/_nuxt');
const rendererPath = join(outputDir, 'server/chunks/routes/renderer.mjs');

if (!existsSync(rendererPath) || !existsSync(publicDir)) {
	console.error(
		`check-bundle-budget: no server build at ${outputDir}.\n` +
			'Run `nuxt build` in apps/web first (a `nuxt generate` output has no renderer to read the entry from).'
	);
	process.exit(2);
}

const entry = /entryFileName = "([^"]+)"/.exec(readFileSync(rendererPath, 'utf8'))?.[1];
if (!entry) {
	console.error(`check-bundle-budget: no entryFileName in ${rendererPath}.`);
	process.exit(2);
}

/** `from "./x.js"` and bare `import "./x.js"`; never `import("./x.js")`. */
const FROM_IMPORT = /\bfrom\s*["']\.\/([\w\-.]+\.js)["']/g;
const BARE_IMPORT = /(?:^|[;\n}])\s*import\s*["']\.\/([\w\-.]+\.js)["']/g;

function staticImports(file: string): string[] {
	const source = readFileSync(join(publicDir, file), 'utf8');
	const found = new Set<string>();
	for (const pattern of [FROM_IMPORT, BARE_IMPORT]) {
		for (const match of source.matchAll(pattern)) found.add(match[1] as string);
	}
	return [...found];
}

const closure = new Set<string>();
const stack = [entry];
while (stack.length > 0) {
	const file = stack.pop() as string;
	if (closure.has(file) || !existsSync(join(publicDir, file))) continue;
	closure.add(file);
	stack.push(...staticImports(file));
}

if (!closure.has(entry)) {
	console.error(`check-bundle-budget: entry ${entry} is missing from ${publicDir}.`);
	process.exit(2);
}

const rows = [...closure]
	.map((file) => {
		const bytes = readFileSync(join(publicDir, file));
		return { file, raw: bytes.length, gz: gzipSync(bytes, { level: 9 }).length };
	})
	.sort((a, b) => b.gz - a.gz);

const kb = (bytes: number) => (bytes / 1024).toFixed(1);
const rawTotal = rows.reduce((sum, row) => sum + row.raw, 0);
const gzTotal = rows.reduce((sum, row) => sum + row.gz, 0);
const budget = GZIP_BUDGET_KB * 1024;

console.info(
	`Entry ${entry}: ${rows.length} file${rows.length === 1 ? '' : 's'}, ${kb(rawTotal)} KB raw, ${kb(gzTotal)} KB gzip`
);
console.info('Largest files (gzip):');
for (const row of rows.slice(0, 10)) {
	console.info(`  ${kb(row.gz).padStart(7)} KB  ${row.file}`);
}

if (gzTotal > budget) {
	console.error(
		`\nThe entry closure is ${kb(gzTotal)} KB gzip, over the ${GZIP_BUDGET_KB} KB budget ` +
			`by ${kb(gzTotal - budget)} KB.\n` +
			'Something the boot path imports statically grew or became eager. Load it with a dynamic ' +
			'import() or defineAsyncComponent, or raise GZIP_BUDGET_KB in scripts/check-bundle-budget.ts ' +
			'with a reason in the commit.'
	);
	process.exit(1);
}

console.info(
	`\nWithin the ${GZIP_BUDGET_KB} KB gzip budget (${kb(budget - gzTotal)} KB to spare).`
);
