/**
 * Conformance for `apps/api/scripts/check-convex-patterns.sh`.
 *
 * Every count the gate keeps must equal its baseline: above it is a new
 * violation, below it is a fixed site whose baseline was not lowered. The
 * hand-rolled literal union rule (pattern 6) has to catch the form in every
 * shape the formatter leaves it in, and must not count prose or ordinary
 * `.map` calls. Each case runs the REAL script over a throwaway `apps/api`
 * tree.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	API_ROOT,
	apiTree,
	type GateResult,
	removeTrees,
	runGate as runGateIn,
} from './convexGates.testlib';

const GATE = 'check-convex-patterns.sh';

/** The `<NAME>_BASELINE=<n>` assignments of the real gate. */
const BASELINES = Object.fromEntries(
	[
		...readFileSync(join(API_ROOT, 'scripts', GATE), 'utf8').matchAll(
			/^([A-Z_]+)_BASELINE=(\d+)$/gm
		),
	].map(([, name, count]) => [name, Number(count)])
);

function baseline(name: string): number {
	const count = BASELINES[name];
	if (count === undefined) throw new Error(`${GATE} has no ${name}_BASELINE`);
	return count;
}

const FILTER = baseline('FILTER');
const COLLECT = baseline('COLLECT');

/** A full-table filter scan the gate counts: an inline query().filter() with no index. */
const fullScan = (i: number) =>
	`export const scan${i} = await ctx.db.query('widgets').filter((q) => q.eq(q.field('a'), ${i}));`;
/** An unbounded collect the gate counts: no take/paginate, no `// bounded:`. */
const unboundedCollect = (i: number) =>
	`export const all${i} = await ctx.db.query('widgets').withIndex('by_owner').collect();`;

/**
 * A module holding `filters` full scans and `collects` unbounded collects.
 * The defaults reproduce the debt the real baselines freeze, so a fixture tree
 * matches every baseline exactly unless a case says otherwise.
 */
function debt(filters: number = FILTER, collects: number = COLLECT): string {
	return [
		...Array.from({ length: filters }, (_, i) => fullScan(i)),
		...Array.from({ length: collects }, (_, i) => unboundedCollect(i)),
		'',
	].join('\n');
}

const roots: string[] = [];

afterAll(() => removeTrees(roots));

async function runGate(source: string, path = 'convex/fixture/union.ts'): Promise<GateResult> {
	return runGateIn(
		await apiTree({ 'convex/fixture/debt.ts': debt(), [path]: source }, roots),
		GATE
	);
}

async function runDebt(filters: number, collects: number, extra = ''): Promise<GateResult> {
	const files: Record<string, string> = { 'convex/fixture/debt.ts': debt(filters, collects) };
	if (extra) files['convex/fixture/extra.ts'] = extra;
	return runGateIn(await apiTree(files, roots), GATE);
}

describe('check-convex-patterns: exact baselines', () => {
	it('freezes only the full-scan and collect debt; every other count is zero', () => {
		const others = Object.entries(BASELINES).filter(
			([name]) => name !== 'FILTER' && name !== 'COLLECT'
		);
		expect(others.length).toBeGreaterThan(0);
		for (const [, count] of others) expect(count).toBe(0);
	});

	it('passes when every count equals its baseline', async () => {
		const result = await runDebt(FILTER, COLLECT);

		expect(result.output).not.toContain('FAIL');
		expect(result.code).toBe(0);
	});

	it('fails a count above its baseline as a new violation', async () => {
		const result = await runDebt(FILTER, COLLECT + 1);

		expect(result.code).toBe(1);
		expect(result.output).toContain(
			`FAIL: .collect() unbounded       count=${COLLECT + 1} > baseline=${COLLECT}`
		);
		expect(result.output).toContain('never raise a baseline');
		expect(result.output).not.toContain('stale baseline');
	});

	it.each([
		['query().filter() full-scans', 'FILTER'],
		['.collect() unbounded      ', 'COLLECT'],
	])('fails a %s count below its baseline as stale', async (label, name) => {
		const filters = FILTER - (name === 'FILTER' ? 1 : 0);
		const collects = COLLECT - (name === 'COLLECT' ? 1 : 0);
		const result = await runDebt(filters, collects);
		const expected = name === 'FILTER' ? filters : collects;

		expect(result.code).toBe(1);
		expect(result.output).toContain(
			`FAIL: ${label} count=${expected} < baseline=${baseline(name)} (stale baseline)`
		);
		expect(result.output).toContain('Lower that baseline');
		expect(result.output).not.toContain('counts grew');
	});

	it('reports a grown and a shrunk count from the same run', async () => {
		const result = await runDebt(FILTER + 1, COLLECT - 1);

		expect(result.code).toBe(1);
		expect(result.output).toContain('counts grew');
		expect(result.output).toContain('fell below their baseline');
	});

	it('fails a zero-baseline count that grows', async () => {
		const result = await runDebt(FILTER, COLLECT, "console.log('debug');\n");

		expect(result.code).toBe(1);
		expect(result.output).toContain('FAIL: console.log debug calls    count=1 > baseline=0');
	});

	it('does not count a collect justified with `// bounded:`', async () => {
		const result = await runDebt(
			FILTER,
			COLLECT,
			"export const few = await ctx.db.query('flags').collect(); // bounded: one row per flag\n"
		);

		expect(result.output).not.toContain('FAIL');
		expect(result.code).toBe(0);
	});
});

describe('check-convex-patterns: hand-rolled literal union', () => {
	it.each([
		['single line', 'export const a = v.union(...KINDS.map((kind) => v.literal(kind)));\n'],
		[
			'formatter-split spread',
			'export const a = v.union(\n\t...KINDS.map((kind) => v.literal(kind))\n);\n',
		],
		[
			'first-and-rest destructure',
			'export const a = v.union(v.literal(first), ...rest.map((item) => v.literal(item)));\n',
		],
		[
			'arrow body wrapped onto the next line',
			'export const a = v.union(\n\t...KINDS.map((kind: string) =>\n\t\tv.literal(kind)\n\t)\n);\n',
		],
		['point-free callback', 'export const a = v.union(...KINDS.map(v.literal));\n'],
	])('fails on the %s form', async (_shape, source) => {
		const result = await runGate(source);

		expect(result.code).toBe(1);
		expect(result.output).toContain('hand-rolled literal union: convex/fixture/union.ts:');
		expect(result.output).toContain('FAIL: hand-rolled literal union  count=1 > baseline=0');
	});

	it('ignores comment lines and ordinary maps', async () => {
		const result = await runGate(
			[
				'// v.union(...KINDS.map((kind) => v.literal(kind)))',
				'/**',
				' * v.union(...KINDS.map((kind) => v.literal(kind)))',
				' */',
				'export const ids = items.map((item) => item.id);',
				'export const labels = items.map((item) =>',
				'\t// v.literal(item) would be wrong here',
				'\titem.label',
				');',
				"export const kind = literalUnion(['a', 'b'] as const);",
				'',
			].join('\n')
		);

		expect(result.code).toBe(0);
		expect(result.output).toContain('ok:   hand-rolled literal union  count=0 (baseline=0)');
	});

	it('exempts the helper itself', async () => {
		const result = await runGate(
			'export const helper = v.union(v.literal(first), ...rest.map((value) => v.literal(value)));\n',
			'convex/lib/literalUnion.ts'
		);

		expect(result.code).toBe(0);
		expect(result.output).toContain('ok:   hand-rolled literal union  count=0 (baseline=0)');
	});
});
