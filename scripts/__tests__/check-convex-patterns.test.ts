/**
 * Conformance for the hand-rolled literal union rule in
 * `apps/api/scripts/check-convex-patterns.sh` (pattern 6).
 *
 * `lib/literalUnion.ts` is the one way to build a closed union from a literal
 * list. The rule has to catch the hand-rolled form in every shape the
 * formatter leaves it in, and must not count prose or ordinary `.map` calls,
 * so it runs the REAL script over a throwaway `apps/api` tree per case.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { apiTree, type GateResult, removeTrees, runGate as runGateIn } from './convexGates.testlib';

const GATE = 'check-convex-patterns.sh';

const roots: string[] = [];

afterAll(() => removeTrees(roots));

async function runGate(source: string, path = 'convex/fixture/union.ts'): Promise<GateResult> {
	return runGateIn(await apiTree({ [path]: source }, roots), GATE);
}

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
