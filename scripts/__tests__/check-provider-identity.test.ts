/**
 * The provider-identity ratchet's own gate (SEAMS plan D2).
 *
 * Two halves, and the second is the one that matters: a ratchet nobody has
 * watched FAIL is indistinguishable from `exit 0`. So every exemption the
 * script grants — adapter folders, tests, migrations, comment prose, the
 * allowlist — is proved by a pair: the same seeded violation passes on one side
 * of the line and fails on the other.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../check-provider-identity.sh');
const ALLOWLIST = resolve(import.meta.dirname, '../provider-identity-allowlist.txt');
const COLLISIONS = resolve(import.meta.dirname, '../provider-identity-collisions.txt');
const REPO_ROOT = resolve(import.meta.dirname, '../..');

const DEFAULT_KINDS = ['mta', 'ses', 'resend', 'smtp', 'mandrill'];

type Result = { status: number; output: string };

function runIn(root: string): Result {
	const run = spawnSync('bash', [join(root, 'scripts/check-provider-identity.sh')], {
		cwd: root,
		encoding: 'utf8',
	});
	return { status: run.status ?? -1, output: `${run.stdout}${run.stderr}` };
}

const sandboxes: string[] = [];

afterEach(() => {
	while (sandboxes.length > 0) {
		const dir = sandboxes.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * A miniature repository: the real script, a written allowlist, a kind
 * declaration for it to parse, and whatever source files the case seeds. The
 * script reads `git ls-files`, so the tree is staged.
 */
function sandbox(options: {
	files: Record<string, string>;
	allowlist?: string[];
	collisions?: string[];
	kinds?: string[] | null;
	/** Write the kind array wrapped across lines, as oxfmt does once it is long. */
	wrapKinds?: boolean;
}): string {
	const root = mkdtempSync(join(tmpdir(), 'owlat-provider-identity-'));
	sandboxes.push(root);

	mkdirSync(join(root, 'scripts'), { recursive: true });
	copyFileSync(SCRIPT, join(root, 'scripts/check-provider-identity.sh'));
	writeFileSync(
		join(root, 'scripts/provider-identity-allowlist.txt'),
		`# sandbox allowlist\n${(options.allowlist ?? []).join('\n')}\n`
	);
	writeFileSync(
		join(root, 'scripts/provider-identity-collisions.txt'),
		`# sandbox collisions\n${(options.collisions ?? []).join('\n')}\n`
	);

	const kinds = options.kinds === undefined ? DEFAULT_KINDS : options.kinds;
	if (kinds !== null) {
		const quoted = kinds.map((k) => `'${k}'`);
		const array = options.wrapKinds
			? `[\n${quoted.map((k) => `\t${k},`).join('\n')}\n]`
			: `[${quoted.join(', ')}]`;
		write(
			root,
			'packages/shared/src/transportAlignment.ts',
			`export const SEND_TRANSPORT_KINDS = ${array} as const;\n`
		);
	}

	for (const [path, contents] of Object.entries(options.files)) write(root, path, contents);

	execFileSync('git', ['init', '--quiet'], { cwd: root });
	execFileSync('git', ['add', '--all'], { cwd: root });
	return root;
}

function write(root: string, path: string, contents: string): void {
	const absolute = join(root, path);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents);
}

/** A file whose only interesting property is the comparison it makes. */
function leak(comparison: string): string {
	return `export function decide(kind: string): boolean {\n\treturn ${comparison};\n}\n`;
}

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

type ListEntry = { raw: string; path: string; literal?: string; block: string };

/**
 * The list format the script reads: `# ── block header ──` lines, then entries
 * as `path` or `path:literal`, each optionally carrying a trailing `#` note.
 */
function parseList(contents: string): ListEntry[] {
	const entries: ListEntry[] = [];
	let block = '';
	for (const line of contents.split('\n')) {
		const header = /^#\s*──\s*(.+?)\s*─+\s*$/.exec(line);
		if (header) {
			block = header[1] ?? '';
			continue;
		}
		const trimmed = line.trim();
		if (trimmed === '' || trimmed.startsWith('#')) continue;
		const raw = trimmed.replace(/\s+#.*$/, '').trim();
		const [path, literal] = raw.split(':');
		entries.push({ raw, path: path ?? raw, literal, block });
	}
	return entries;
}

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

describe('provider-identity ratchet, exemptions', () => {
	const violation = leak("kind === 'ses'");

	it.each([
		['an adapter folder under lib/sendProviders', 'apps/api/convex/lib/sendProviders/ses/index.ts'],
		[
			'an adapter folder under domains/providers',
			'apps/api/convex/domains/providers/mandrill/api.ts',
		],
		['a __tests__ directory', 'apps/api/convex/delivery/__tests__/harness.ts'],
		['a test file', 'apps/api/convex/delivery/seam.test.ts'],
		// The exclusion list has to cover the spellings tests actually use, or the
		// header's promise ("tests are out of scope") is one a Playwright page
		// object cannot cash — and the failure text forbids the only remedy it
		// offers. A spec under e2e/ was already exempt by extension; the page
		// object it drives and the data it seeds are the same scaffolding.
		['a component test named .test.tsx', 'apps/web/app/components/Editor.test.tsx'],
		['a spec named .spec.vue', 'apps/web/app/components/Editor.spec.vue'],
		['a Playwright page object', 'apps/web/e2e/page-objects/DeliveryPage.ts'],
		['a Playwright fixture', 'apps/web/e2e/fixtures/test-data.ts'],
		['a migration', 'apps/api/convex/migrations/0019_relay_kinds.ts'],
		['convex generated code', 'apps/api/convex/_generated/api.ts'],
	])('exempts %s', (_label, path) => {
		const root = sandbox({ files: { [path]: violation } });
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});

	it.each([
		['a webhook adapter written one file per kind', 'apps/api/convex/webhooks/adapters/ses.ts'],
		[
			'a domain provider written one file per kind',
			'apps/api/convex/domains/providers/mandrill.ts',
		],
	])('exempts %s', (_label, path) => {
		// `webhooks/adapters/` is file-per-kind where `lib/sendProviders/` is
		// folder-per-kind, and an adapter's own `if (kind !== 'ses') return;`
		// self-guard is the sanctioned case — inside its own module an adapter IS
		// that vendor. Keying only on directory segments would fail it, and the
		// failure text forbids the only remedy it would leave.
		const root = sandbox({ files: { [path]: violation } });
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});

	it('exempts an adapter folder under integrationImports/providers', () => {
		const root = sandbox({
			files: { 'apps/api/convex/integrationImports/providers/mandrill/api.ts': violation },
		});
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});

	it('does not exempt a file merely named after a kind', () => {
		const root = sandbox({ files: { 'apps/api/convex/delivery/ses.ts': violation } });
		const result = runIn(root);

		expect(result.output).toContain('apps/api/convex/delivery/ses.ts:2');
		expect(result.status).toBe(1);
	});

	it.each([
		['a per-vendor UI bundle', 'apps/web/app/pages/dashboard/delivery/smtp/CredentialsPanel.ts'],
		['a per-vendor route directory', 'apps/web/app/pages/setup/ses/index.vue'],
		['a kind-named directory in the backend', 'apps/api/convex/delivery/ses/helper.ts'],
	])('does not exempt %s: a kind-named directory outside an adapter root', (_label, path) => {
		// The exemption is anchored to lib/sendProviders/, domains/providers/,
		// integrationImports/providers/ and webhooks/adapters/, not to "any path
		// segment that spells a kind". A per-vendor folder of dashboard panels or
		// wizard routes is precisely the next-provider host edit the ecosystem goal
		// has to stop, and it would name itself after the kind on the way in.
		const root = sandbox({ files: { [path]: leak("provider === 'smtp'") } });
		const result = runIn(root);

		expect(result.output).toContain(path);
		expect(result.status).toBe(1);
	});

	it('exempts the same literal quoted in comments, and only in comments', () => {
		const documented = [
			'/**',
			" * This gate used to read `providerType === 'ses'`, which is exactly what",
			' * the capability below replaced.',
			' */',
			'export function decide(kind: string): boolean {',
			"\treturn eligible(kind); // was: kind !== 'mta'",
			'}',
			'',
		].join('\n');
		const root = sandbox({ files: { 'apps/api/convex/delivery/documented.ts': documented } });
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);

		const withCode = sandbox({
			files: {
				'apps/api/convex/delivery/documented.ts': documented.replace(
					'\treturn eligible(kind);',
					"\tif (kind === 'ses') return false;\n\treturn eligible(kind);"
				),
			},
		});
		const second = runIn(withCode);

		expect(second.output).toContain('apps/api/convex/delivery/documented.ts:6');
		expect(second.status).toBe(1);
	});

	it.each([
		[
			'a trailing block comment on a line of code',
			[
				'export function decide(kind: string): boolean {',
				"\treturn eligible(kind); /* was: kind === 'ses' */",
				'}',
				'',
			],
		],
		[
			'a block comment whose body lines do not start with *',
			[
				'/*',
				"  The old gate compared kind === 'ses' before the capability landed;",
				'  the catalog answers it now.',
				'*/',
				'export function decide(kind: string): boolean {',
				'\treturn eligible(kind);',
				'}',
				'',
			],
		],
		[
			'a block comment opened mid-line and closed on a later one',
			[
				'export function decide(kind: string): boolean {',
				"\treturn eligible(kind); /* this used to read kind === 'ses'",
				"   and then fell through to kind === 'mta' */",
				'}',
				'',
			],
		],
	])('exempts a kind quoted in %s', (_label, lines) => {
		// House style quotes the literal a seam USED to be spelled with; a stripper
		// that only understood `//` tails and lines opening with `*` would punish
		// that prose, and the failure text offers no sanctioned remedy for it.
		const root = sandbox({
			files: { 'apps/api/convex/delivery/documented.ts': (lines as string[]).join('\n') },
		});
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});

	it('still sees code that follows a closed block comment on the same line', () => {
		// The other half of the pair: stripping must end where the comment ends.
		const root = sandbox({
			files: {
				'apps/api/convex/delivery/inline.ts': [
					'export function decide(kind: string): boolean {',
					"\t/* legacy */ if (kind === 'ses') return false;",
					'\treturn eligible(kind);',
					'}',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('apps/api/convex/delivery/inline.ts:2');
		expect(result.status).toBe(1);
	});

	it('exempts the MTA, which speaks a different alphabet with the same spelling', () => {
		const root = sandbox({
			files: { 'apps/mta/src/routes/routingDecision.ts': leak("decision === 'mta'") },
		});
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});

	it('reaches the UI, the shared packages and the plugin tier, not just the backend', () => {
		// examples/ is a workspace root (examples/plugins/*, examples/conformance)
		// and the home of the tier whose whole promise is that a provider ships
		// without host edits — P3.3's mock plugin ESP lands there. A kind literal in
		// that tier is the loudest possible contradiction, so it is in scope.
		const root = sandbox({
			files: {
				'apps/web/app/components/delivery/NewEditor.vue': [
					'<template>',
					'\t<div v-if="provider === \'resend\'">key</div>',
					'</template>',
					'',
				].join('\n'),
				'packages/shared/src/newRouting.ts': leak("kind !== 'smtp'"),
				'apps/setup-cli/src/commands/newPrompt.ts': leak("provider === 'ses'"),
				'examples/conformance/src/mockEsp.ts': leak("kind === 'mandrill'"),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('examples/conformance/src/mockEsp.ts');
		expect(result.output).toContain('FAIL: 4 file(s)');
		expect(result.output).toContain('apps/web/app/components/delivery/NewEditor.vue:2');
		expect(result.output).toContain('packages/shared/src/newRouting.ts');
		expect(result.output).toContain('apps/setup-cli/src/commands/newPrompt.ts');
		expect(result.status).toBe(1);
	});

	it.each([
		['one line', ['\t<!-- the credentials block used to be v-if="provider === \'ses\'" -->']],
		[
			'several lines',
			[
				'\t<!--',
				'\t\tthe credentials block used to be v-if="provider === \'ses\'";',
				'\t\tthe descriptors render it now',
				'\t-->',
			],
		],
	])('exempts a kind named inside a template comment spanning %s', (_label, comment) => {
		const root = sandbox({
			files: {
				'apps/web/app/components/delivery/Documented.vue': [
					'<template>',
					...(comment as string[]),
					'\t<CredentialFields :fields="fields" />',
					'</template>',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});
});

describe('provider-identity ratchet, a string is not a comment', () => {
	// The stripper's job is to hide PROSE. Every case below is the opposite
	// mistake — hiding code because a string happened to contain a comment
	// opener — and each is paired with the prose case it must not break, because
	// this is the direction where a ratchet fails OPEN and says `ok:`.

	it('sees a comparison on a line that also carries a URL', () => {
		// `//` inside a string is not a comment. Provider doc links sit in exactly
		// the per-vendor panels the allowlist carries as debt, so this is both a
		// natural accident and a one-character deliberate bypass.
		const root = sandbox({
			files: {
				'apps/web/app/components/delivery/Docs.vue': [
					'<template>',
					'\t<a href="https://docs.aws.amazon.com/ses" v-if="provider === \'ses\'">docs</a>',
					'</template>',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('apps/web/app/components/delivery/Docs.vue:2');
		expect(result.status).toBe(1);
	});

	it('still hides a comment that follows a URL on the same line', () => {
		// The pair: teaching the stripper about strings must not stop a real `//`
		// tail from being a comment.
		const root = sandbox({
			files: {
				'apps/api/convex/delivery/documented.ts': [
					'export function decide(kind: string): boolean {',
					"\treturn eligible(kind); // https://docs.aws.amazon.com/ses — was kind === 'ses'",
					'}',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});

	it('does not let a glob string open a block comment that swallows the rest of the file', () => {
		// `'*/*'` used to start a block comment that never closed, so EVERY line
		// below it went unread — silently, for the whole file. Twenty-one tracked
		// files ended a run in that state, including nuxt.config.ts (a route glob)
		// and the media picker below.
		const root = sandbox({
			files: {
				'apps/web/app/components/MediaPicker.vue': [
					'<script setup lang="ts">',
					"const resolvedAccept = props.allowAllFiles ? '*/*' : props.accept;",
					'',
					'function label(kind: string): string {',
					"\treturn kind === 'ses' ? 'Amazon SES' : 'other';",
					'}',
					'</script>',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('apps/web/app/components/MediaPicker.vue:5');
		expect(result.status).toBe(1);
	});

	it('passes the same glob with no comparison under it', () => {
		const root = sandbox({
			files: {
				'apps/web/app/components/MediaPicker.vue': [
					'<script setup lang="ts">',
					"const resolvedAccept = props.allowAllFiles ? '*/*' : props.accept;",
					'</script>',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});

	it('follows a template literal across lines and keeps reading after it closes', () => {
		// A template literal is the one string that spans lines, so its state is
		// carried across them. Carrying it means the `//` in the URL inside it is
		// not a comment, and closing it means the branch underneath is still code.
		const root = sandbox({
			files: {
				'apps/web/app/composables/useHelp.ts': [
					'export const help = `',
					'\tRead https://docs.aws.amazon.com/ses/latest/ first.',
					'`;',
					'export function decide(kind: string): boolean {',
					"\treturn kind === 'ses';",
					'}',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('apps/web/app/composables/useHelp.ts:5');
		expect(result.status).toBe(1);
	});

	it('does not let an apostrophe in template prose hide the next line', () => {
		// A single quote in a Vue text node opens nothing: quoted strings cannot
		// span lines, so the stripper forgets them at the newline rather than
		// reading the rest of the file as one long string.
		const root = sandbox({
			files: {
				'apps/web/app/components/delivery/Prose.vue': [
					'<template>',
					"\t<p>You'll need credentials before sending.</p>",
					'\t<div v-if="provider === \'resend\'">key</div>',
					'</template>',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('apps/web/app/components/delivery/Prose.vue:3');
		expect(result.status).toBe(1);
	});

	it('fails loudly when it reaches the end of a file still inside a comment', () => {
		// The backstop for the whole family: no compiling source file ends inside
		// a block comment, so if the stripper thinks one did, the stripper is
		// wrong — and everything after its mistake was read as prose. Better a red
		// gate naming the file than a green one that read half of it.
		const root = sandbox({
			files: {
				'apps/api/convex/delivery/malformed.ts': [
					"/* the old gate compared kind === 'ses'",
					'export function decide(kind: string): boolean {',
					'\treturn eligible(kind);',
					'}',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('still');
		expect(result.output).toContain('apps/api/convex/delivery/malformed.ts');
		expect(result.output).toContain('block comment at end of file');
		expect(result.status).toBe(1);
	});
});

describe('provider-identity ratchet, the allowlist', () => {
	it('passes a violation in an allowlisted file', () => {
		const root = sandbox({
			files: { 'apps/api/convex/delivery/sanctioned.ts': leak("kind === 'mta'") },
			allowlist: ['apps/api/convex/delivery/sanctioned.ts'],
		});
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.output).toContain('1 allowlisted site(s) remain');
		expect(result.status).toBe(0);
	});

	it('fails a stale entry whose file no longer holds a literal, so the list only shrinks', () => {
		const root = sandbox({
			files: { 'apps/api/convex/delivery/cleaned.ts': leak('kind === OWN_ARM_TRANSPORT_KIND') },
			allowlist: ['apps/api/convex/delivery/cleaned.ts'],
		});
		const result = runIn(root);

		expect(result.output).toContain('stale allowlist entr');
		expect(result.output).toContain('apps/api/convex/delivery/cleaned.ts');
		expect(result.output).toContain('only ever moves down');
		expect(result.status).toBe(1);
	});

	it('fails a stale entry whose file is gone', () => {
		const root = sandbox({
			files: { 'apps/api/convex/delivery/kept.ts': leak('kind === OWN_ARM_TRANSPORT_KIND') },
			allowlist: ['apps/api/convex/delivery/deleted.ts'],
		});
		const result = runIn(root);

		expect(result.output).toContain('stale allowlist entr');
		expect(result.output).toContain('apps/api/convex/delivery/deleted.ts');
		expect(result.status).toBe(1);
	});

	it.each([
		['the allowlist', 'scripts/provider-identity-allowlist.txt'],
		['the collisions list', 'scripts/provider-identity-collisions.txt'],
	])('fails when %s is missing', (_label, path) => {
		const root = sandbox({ files: { 'apps/api/convex/delivery/clean.ts': leak('kind === OWN') } });
		rmSync(join(root, path));
		const result = runIn(root);

		expect(result.output).toContain('is missing');
		expect(result.status).toBe(1);
	});

	it('passes with both lists empty — the end state A1 asks for', () => {
		const root = sandbox({ files: { 'apps/api/convex/delivery/clean.ts': leak('kind === OWN') } });
		const result = runIn(root);

		expect(result.output).toContain('0 allowlisted site(s) remain');
		expect(result.status).toBe(0);
	});
});

describe('provider-identity ratchet, the collisions list', () => {
	// Debt and vocabulary collisions are separate files on purpose: the allowlist
	// drives to zero (that count is what A1 measures) and the collisions list is
	// permanent, so a permanent entry must not be able to hold the debt count
	// above zero forever.
	it('licenses a spelling that belongs to another vocabulary', () => {
		const root = sandbox({
			files: { 'apps/web/server/api/setup/apply.post.ts': leak("profiles.includes('mta')") },
			collisions: ['apps/web/server/api/setup/apply.post.ts:mta'],
		});
		const result = runIn(root);

		expect(result.output).toContain('0 allowlisted site(s) remain, 1 vocabulary collision');
		expect(result.status).toBe(0);
	});

	it('licenses that spelling only — a real kind branch in the same file still fails', () => {
		// The collisions list is PERMANENT, so a file-granular licence would blind
		// the gate to this file forever: the compose-profile entry would silently
		// cover a `kind === 'ses'` branch added to the same handler years later.
		const root = sandbox({
			files: {
				'apps/web/server/api/setup/apply.post.ts': [
					'export async function apply(profiles: string[], kind: string) {',
					"\tif (profiles.includes('mta')) await preflight();",
					"\tif (kind === 'ses') await verifyIdentity();",
					'}',
					'',
				].join('\n'),
			},
			collisions: ['apps/web/server/api/setup/apply.post.ts:mta'],
		});
		const result = runIn(root);

		expect(result.output).toContain('apps/web/server/api/setup/apply.post.ts:3');
		expect(result.output).not.toContain('apply.post.ts:2');
		expect(result.status).toBe(1);
	});

	it('fails a qualified entry whose spelling is gone, even though the file still has others', () => {
		const root = sandbox({
			files: { 'apps/api/convex/delivery/moved.ts': leak("kind === 'ses'") },
			allowlist: ['apps/api/convex/delivery/moved.ts'],
			collisions: ['apps/api/convex/delivery/moved.ts:mta'],
		});
		const result = runIn(root);

		expect(result.output).toContain('stale collision entr');
		expect(result.output).toContain('apps/api/convex/delivery/moved.ts:mta');
		expect(result.status).toBe(1);
	});

	it('rejects a qualifier that is not a declared kind, instead of calling it stale', () => {
		const root = sandbox({
			files: { 'apps/api/convex/delivery/leak.ts': leak("kind === 'ses'") },
			collisions: ['apps/api/convex/delivery/leak.ts:postmark'],
		});
		const result = runIn(root);

		expect(result.output).toContain('not a declared kind');
		expect(result.output).toContain('apps/api/convex/delivery/leak.ts:postmark');
		expect(result.status).toBe(1);
	});

	it('fails a stale collision entry, naming its own file', () => {
		const root = sandbox({
			files: { 'apps/api/convex/delivery/cleaned.ts': leak('kind === OWN_ARM_TRANSPORT_KIND') },
			collisions: ['apps/api/convex/delivery/cleaned.ts'],
		});
		const result = runIn(root);

		expect(result.output).toContain('stale collision entr');
		expect(result.output).toContain('scripts/provider-identity-collisions.txt');
		expect(result.status).toBe(1);
	});

	it('points an unlicensed violation at both files, with the right one first', () => {
		const root = sandbox({ files: { 'apps/api/convex/delivery/leak.ts': leak("kind === 'ses'") } });
		const result = runIn(root);

		expect(result.output).toContain('Do NOT add a line to');
		expect(result.output).toContain('scripts/provider-identity-collisions.txt');
		expect(result.status).toBe(1);
	});
});

describe('provider-identity ratchet, the kind list', () => {
	it('follows the catalog: a newly declared kind is guarded the day it lands', () => {
		const files = { 'apps/api/convex/delivery/newKind.ts': leak("kind === 'postmark'") };

		const before = runIn(sandbox({ files }));
		expect(before.output).toContain('ok:');
		expect(before.status).toBe(0);

		const after = runIn(sandbox({ files, kinds: [...DEFAULT_KINDS, 'postmark'] }));
		expect(after.output).toContain('apps/api/convex/delivery/newKind.ts:2');
		expect(after.status).toBe(1);
	});

	it('guards adapter folders of a newly declared kind too', () => {
		const root = sandbox({
			files: { 'apps/api/convex/lib/sendProviders/postmark/index.ts': leak("kind === 'postmark'") },
			kinds: [...DEFAULT_KINDS, 'postmark'],
		});
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});

	it('reads the declaration when the formatter has wrapped it across lines', () => {
		// A sixth kind pushes the array past oxfmt's print width and it wraps. A
		// line-anchored parser would then report the declaration as MISSING and
		// fail lint:providers with "the declaration moved" — on a cosmetic
		// reformat, sending the reader hunting for a move that never happened.
		const root = sandbox({
			files: { 'apps/api/convex/delivery/newKind.ts': leak("kind === 'postmark'") },
			kinds: [...DEFAULT_KINDS, 'postmark'],
			wrapKinds: true,
		});
		const result = runIn(root);

		expect(result.output).not.toContain('could not read SEND_TRANSPORT_KINDS');
		expect(result.output).toContain('apps/api/convex/delivery/newKind.ts:2');
		expect(result.status).toBe(1);
	});

	it('fails loudly when the kind declaration cannot be read', () => {
		const root = sandbox({
			files: { 'apps/api/convex/delivery/seededLeak.ts': leak("kind === 'ses'") },
			kinds: null,
		});
		const result = runIn(root);

		expect(result.output).toContain('SEND_TRANSPORT_KINDS');
		expect(result.status).toBe(1);
	});
});
