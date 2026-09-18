/**
 * The provider-identity ratchet's own gate (SEAMS plan D2), part one: the run
 * against the repository it guards, and the violations it must catch.
 *
 * A ratchet nobody has watched FAIL is indistinguishable from `exit 0`, so
 * every comparison shape the script claims to see is seeded here and proved to
 * fail. The exemptions it grants are proved in
 * check-provider-identity.exemptions.test.ts, and the two lists it reads in
 * check-provider-identity.lists.test.ts.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	ALLOWLIST,
	COLLISIONS,
	REPO_ROOT,
	cleanupSandboxes,
	leak,
	parseList,
	runIn,
	sandbox,
} from './providerIdentity.testlib';

afterEach(cleanupSandboxes);

describe('provider-identity ratchet, on the repository it guards', () => {
	it('passes', () => {
		const run = spawnSync('bash', ['scripts/check-provider-identity.sh'], {
			cwd: REPO_ROOT,
			encoding: 'utf8',
		});
		expect(`${run.stdout}${run.stderr}`).toContain('ok:');
		expect(run.status).toBe(0);
	});

	it.each([
		['the allowlist', ALLOWLIST],
		['the collisions list', COLLISIONS],
	])('ships %s as real, deduplicated, blocked paths', (_label, file) => {
		const contents = readFileSync(file, 'utf8');
		const entries = parseList(contents);

		expect(entries.length).toBeGreaterThan(0);
		expect(new Set(entries.map((entry) => entry.raw)).size).toBe(entries.length);
		for (const entry of entries) {
			// Every licensed site is a real file, in scope, and under a block that
			// says what it is — an entry with no family is how a survivor stops
			// being anybody's problem.
			expect(existsSync(resolve(REPO_ROOT, entry.path)), `${entry.path} does not exist`).toBe(true);
			expect(entry.path).toMatch(/^(apps|packages|examples)\//);
			expect(entry.block, `${entry.raw} sits under no block header`).not.toBe('');
		}
	});

	it.each([
		['the allowlist', ALLOWLIST],
		['the collisions list', COLLISIONS],
	])('writes each entry of %s exactly once, in the list itself', (_label, file) => {
		// The lists used to repeat every path in the family prose as well as in the
		// enforced list at the bottom. Only the enforced half is checked in either
		// direction, so a sweep that deleted one line and not the other left the
		// file documenting debt — with an owner — for a site that was already
		// clear. Prose may DISCUSS a path inside a sentence; a comment line that is
		// nothing but a path is the second copy coming back.
		const restated = readFileSync(file, 'utf8')
			.split('\n')
			.filter((line) =>
				/^#\s*(apps|packages|examples)\/\S+\.(ts|tsx|vue)(:[a-z0-9_-]+)?\s*$/.test(line)
			);
		expect(restated, 'these comment lines restate an entry — keep the entry only').toEqual([]);
	});

	it('gives every allowlist entry a family and an owning piece', () => {
		// Debt with no owner is just a permanent exemption with better manners. The
		// collisions list is exempt from this on purpose: nothing owns a vocabulary
		// collision because there is nothing to clear.
		for (const entry of parseList(readFileSync(ALLOWLIST, 'utf8'))) {
			expect(entry.block, `${entry.raw} has no family/owner header`).toMatch(
				/^[a-z0-9-]+ \(owner: .{10,}\)$/
			);
		}
	});

	it('keeps debt and vocabulary collisions in separate lists', () => {
		// The split is what makes acceptance criterion A1 reachable: the allowlist
		// is debt that drives to zero, the collisions file is permanent. A file in
		// both would let a real leak hide behind a collision licence.
		const debt = new Set(parseList(readFileSync(ALLOWLIST, 'utf8')).map((entry) => entry.path));
		const collisions = parseList(readFileSync(COLLISIONS, 'utf8'));
		expect(collisions.filter((entry) => debt.has(entry.path)).map((entry) => entry.raw)).toEqual(
			[]
		);
	});

	it('qualifies every permanent collision licence with the one spelling it excuses', () => {
		// A bare path in the collisions list never expires, so it would license a
		// real `kind === 'ses'` branch added to that file years from now. The debt
		// list may use the coarse form — it is on its way out.
		for (const entry of parseList(readFileSync(COLLISIONS, 'utf8'))) {
			expect(entry.literal, `${entry.raw} licenses the whole file, forever`).toMatch(
				/^[a-z0-9_-]+$/
			);
		}
	});
});

describe('provider-identity ratchet, seeded violations', () => {
	it.each([
		['strict equality', "kind === 'ses'"],
		['strict inequality', "kind !== 'mta'"],
		['loose equality', "kind == 'resend'"],
		['reversed operands', "'smtp' === kind"],
		['double quotes', 'kind === "mandrill"'],
		['a template literal', 'kind === `ses`'],
		// Membership is not a nicety: every surviving Inventory-A family is a
		// MULTI-kind question ("which kinds accept a custom return path"), and the
		// idiomatic way to write one — the way an author blocked by `===` reaches
		// for next — is an array or a Set, not a chain of comparisons.
		['array membership', "['ses', 'resend'].includes(kind)"],
		['set membership', "new Set(['ses', 'smtp']).has(kind)"],
		['a membership argument', "RELAY_KINDS.includes('ses')"],
		['a Set lookup argument', "configured.has('mandrill')"],
		['a prefix test', "kind.startsWith('mta')"],
		// The same question one spelling further out. `indexOf(...) !== -1` is
		// where an author blocked by both `===` and `.includes` lands next, and
		// `lastIndexOf` does not contain `indexOf` (capital I), so it is its own
		// alternative and needs its own case.
		['an indexOf test', "kinds.indexOf('ses') !== -1"],
		['a lastIndexOf test', "kinds.lastIndexOf('mta') === 0"],
		['an inline array asked with some', "['ses', 'resend'].some((k) => k === kind)"],
		[
			'an inline array asked with find',
			"['ses', 'mandrill'].find((k) => k === kind) !== undefined",
		],
	])('fails on %s', (_label, comparison) => {
		const root = sandbox({ files: { 'apps/api/convex/delivery/seededLeak.ts': leak(comparison) } });
		const result = runIn(root);

		expect(result.output).toContain('apps/api/convex/delivery/seededLeak.ts:2');
		expect(result.output).toContain(comparison);
		expect(result.output).toContain('Ask the capability, not the name');
		expect(result.status).toBe(1);
	});

	it('fails on a switch arm', () => {
		const root = sandbox({
			files: {
				'apps/api/convex/delivery/seededSwitch.ts': [
					'export function label(kind: string): string {',
					'\tswitch (kind) {',
					"\t\tcase 'resend':",
					"\t\t\treturn 'Resend';",
					'\t\tdefault:',
					"\t\t\treturn '';",
					'\t}',
					'}',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('apps/api/convex/delivery/seededSwitch.ts:3');
		expect(result.status).toBe(1);
	});

	it('fails on a comparison the formatter split across two lines', () => {
		// A long condition is printed with the operator at the end of one line and
		// the literal alone on the next. A per-line grep calls that clean, so the
		// gate would be one `bun run ox:fmt` away from being bypassable.
		const root = sandbox({
			files: {
				'apps/api/convex/delivery/wrapped.ts': [
					'export function decide(route: { providerType: string }): boolean {',
					'\treturn (',
					'\t\troute.providerType.trim().toLowerCase() ===',
					"\t\t\t'resend'",
					'\t);',
					'}',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('apps/api/convex/delivery/wrapped.ts:4');
		expect(result.status).toBe(1);
	});

	it.each([
		[
			'a membership array the formatter split one element per line',
			[
				'export function decide(kind: string): boolean {',
				'\treturn [',
				"\t\t'ses',",
				"\t\t'resend',",
				"\t\t'mandrill',",
				'\t].includes(kind);',
				'}',
				'',
			],
			6,
		],
		[
			'a membership argument the formatter put on its own line',
			[
				'export function decide(providerDescriptorName: string): boolean {',
				'\treturn providerDescriptorName.includes(',
				"\t\t'ses'",
				'\t);',
				'}',
				'',
			],
			3,
		],
	])('fails on %s', (_label, lines, line) => {
		// `bun run ox:fmt` prints a long membership test as an array one element per
		// line, and a long argument on its own line. Membership is the shape the
		// question takes once `===` is blocked, so a per-line matcher would leave
		// the gate one cosmetic reformat away from bypassable — for exactly the
		// multi-kind questions the surviving families are made of.
		const root = sandbox({
			files: { 'apps/api/convex/delivery/wrappedMembership.ts': (lines as string[]).join('\n') },
		});
		const result = runIn(root);

		expect(result.output).toContain(`apps/api/convex/delivery/wrappedMembership.ts:${line}`);
		expect(result.status).toBe(1);
	});

	it('reports a comparison once, on the line that completes it', () => {
		// The window is two lines of lookback, and those two lines contain every
		// comparison they made themselves — already reported where they happened.
		// Only a match that ends inside the current line is new; without that, one
		// leak would be reported three times and a reviewer would go looking for
		// three.
		const root = sandbox({
			files: {
				'apps/api/convex/delivery/once.ts': [
					'export function decide(kind: string): boolean {',
					"\tif (kind === 'ses') return false;",
					'\treturn true;',
					'}',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('apps/api/convex/delivery/once.ts:2');
		expect(result.output).not.toContain('once.ts:3');
		expect(result.output).not.toContain('once.ts:4');
		expect(result.output).toContain('FAIL: 1 file(s)');
		expect(result.status).toBe(1);
	});

	it('does not read a wrapped kind ARRAY as a comparison', () => {
		// The other side of the window: a declaration printed one element per line
		// is the catalog, the presets and every <option> list. Widening far enough
		// to flag those would flag the declaration the whole plan wants code to
		// read.
		const root = sandbox({
			files: {
				'apps/api/convex/lib/sendProviders/kinds.ts': [
					'export const RELAY_KINDS = [',
					"\t'ses',",
					"\t'resend',",
					'] as const;',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});

	it('reports every violating file, not just the first', () => {
		const root = sandbox({
			files: {
				'apps/api/convex/delivery/one.ts': leak("kind === 'ses'"),
				'apps/api/convex/domains/two.ts': leak("kind !== 'mandrill'"),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('FAIL: 2 file(s)');
		expect(result.output).toContain('apps/api/convex/delivery/one.ts');
		expect(result.output).toContain('apps/api/convex/domains/two.ts');
		expect(result.status).toBe(1);
	});

	it('passes on a comparison against the own-arm constant, not a literal', () => {
		const root = sandbox({
			files: {
				'apps/api/convex/delivery/named.ts': leak('kind === OWN_ARM_TRANSPORT_KIND'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});

	it('passes on a literal that is not a declared kind', () => {
		const root = sandbox({
			files: { 'apps/api/convex/delivery/other.ts': leak("channel === 'webhook'") },
		});
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});
});
