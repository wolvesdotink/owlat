/**
 * Guard: `domains/lifecycle.ts` is the only module that writes `domains` rows.
 *
 * The lifecycle is split across a pure reducer, an effect runner and four
 * feature editors (`lifecycleDmarc`, `lifecycleReceiving`, `lifecycleReturnPath`,
 * `lifecycleDkim`). The editors hold no write of their own: each one goes
 * through `patchDomainRecords`, so the single-writer rule stays one function
 * rather than five files that each promise to keep it. The source scan makes
 * that structural: a `ctx.db.patch/replace/delete` on a domain id, or a
 * `ctx.db.insert('domains', …)`, anywhere else in `convex/` fails here unless it
 * is on the short, explained allowlist below.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CONVEX_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WRITER = 'domains/lifecycle.ts';
const EDITORS = [
	'domains/lifecycleDmarc.ts',
	'domains/lifecycleReceiving.ts',
	'domains/lifecycleReturnPath.ts',
	'domains/lifecycleDkim.ts',
];

/**
 * Writers outside the lifecycle, each with the reason it may bypass it. An
 * entry whose file no longer writes fails the stale check, so the list only
 * shrinks.
 */
const ALLOWED_OUTSIDE_WRITERS: Record<string, string> = {
	'devShortcuts/forceVerifyDomain.ts':
		'dev-only shortcut that forces `verified` without DNS; gated by devShortcuts/_guard.ts',
	'seedDemo/loaders/domains.ts':
		'demo seed inserts verified rows directly so no provider registration is scheduled',
};

// A patch/replace/delete whose first argument (after an optional `'domains'`
// table name) is a domain id expression.
const DOMAIN_ID_WRITE =
	/ctx\.db\.(?:patch|replace|delete)\(\s*(?:'domains'\s*,\s*)?(?:args\.domainId|domainId|domain\._id)\s*[,)]/;
const DOMAIN_INSERT = /ctx\.db\.insert\(\s*'domains'\s*,/;
const ANY_DB_WRITE = /ctx\.db\.(?:patch|replace|delete|insert)\(/;

function convexSourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === '__tests__' || entry.name === '_generated') continue;
		if (entry.name === 'node_modules') continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...convexSourceFiles(path));
		else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(path);
	}
	return files;
}

const sources = new Map(
	convexSourceFiles(CONVEX_ROOT).map((file) => [
		relative(CONVEX_ROOT, file).split(sep).join('/'),
		readFileSync(file, 'utf8'),
	])
);

function writesDomains(source: string): boolean {
	return DOMAIN_ID_WRITE.test(source) || DOMAIN_INSERT.test(source);
}

describe('domains single writer (source scan)', () => {
	it('scans the convex tree', () => {
		// A broken root would make every assertion below pass vacuously.
		expect(sources.size).toBeGreaterThan(100);
		for (const file of [WRITER, ...EDITORS]) expect(sources.has(file)).toBe(true);
	});

	it('recognises the write shapes it guards', () => {
		expect(DOMAIN_ID_WRITE.test('await ctx.db.patch(args.domainId, { status })')).toBe(true);
		expect(DOMAIN_ID_WRITE.test('await ctx.db.patch(\n\t\tdomain._id,\n\t\t{})')).toBe(true);
		expect(DOMAIN_ID_WRITE.test("await ctx.db.replace('domains', domainId, row)")).toBe(true);
		expect(DOMAIN_ID_WRITE.test('await ctx.db.delete(args.domainId);')).toBe(true);
		expect(DOMAIN_INSERT.test("await ctx.db.insert('domains', {")).toBe(true);
		// Other tables' ids that merely start with the same letters do not count.
		expect(DOMAIN_ID_WRITE.test('await ctx.db.patch(domainIdentity._id, {})')).toBe(false);
		expect(DOMAIN_INSERT.test("await ctx.db.insert('domainsArchive', {")).toBe(false);
	});

	it('writes domains rows only in domains/lifecycle.ts and the allowlisted files', () => {
		const offenders = [...sources]
			.filter(([file]) => file !== WRITER && !(file in ALLOWED_OUTSIDE_WRITERS))
			.filter(([, source]) => writesDomains(source))
			.map(([file]) => file);
		expect(offenders).toEqual([]);
	});

	it('has no stale allowlist entry', () => {
		const stale = Object.keys(ALLOWED_OUTSIDE_WRITERS).filter(
			(file) => !writesDomains(sources.get(file) ?? '')
		);
		expect(stale).toEqual([]);
	});

	it('the feature editors hold no database write of their own', () => {
		for (const editor of EDITORS) {
			const source = sources.get(editor) ?? '';
			expect(ANY_DB_WRITE.test(source), editor).toBe(false);
			expect(source, editor).toMatch(/\bpatchDomainRecords\(/);
		}
	});

	it('the lifecycle itself still writes (the scan is not vacuous)', () => {
		const source = sources.get(WRITER) ?? '';
		expect(DOMAIN_ID_WRITE.test(source)).toBe(true);
		expect(DOMAIN_INSERT.test(source)).toBe(true);
	});
});
