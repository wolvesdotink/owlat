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
	kinds?: string[] | null;
}): string {
	const root = mkdtempSync(join(tmpdir(), 'owlat-provider-identity-'));
	sandboxes.push(root);

	mkdirSync(join(root, 'scripts'), { recursive: true });
	copyFileSync(SCRIPT, join(root, 'scripts/check-provider-identity.sh'));
	writeFileSync(
		join(root, 'scripts/provider-identity-allowlist.txt'),
		`# sandbox allowlist\n${(options.allowlist ?? []).join('\n')}\n`
	);

	const kinds = options.kinds === undefined ? DEFAULT_KINDS : options.kinds;
	if (kinds !== null) {
		write(
			root,
			'packages/shared/src/transportAlignment.ts',
			`export const SEND_TRANSPORT_KINDS = [${kinds.map((k) => `'${k}'`).join(', ')}] as const;\n`
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

	it('ships an allowlist of real, deduplicated, explained paths', () => {
		const contents = readFileSync(ALLOWLIST, 'utf8');
		const entries = contents
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line !== '' && !line.startsWith('#'));

		expect(entries.length).toBeGreaterThan(0);
		expect(new Set(entries).size).toBe(entries.length);
		for (const entry of entries) {
			// Every licensed file is a real file, in scope, and named in the prose
			// above the list — an entry with no family and no owner is how a
			// survivor stops being anybody's problem.
			expect(existsSync(resolve(REPO_ROOT, entry)), `${entry} does not exist`).toBe(true);
			expect(entry).toMatch(/^(apps|packages)\//);
			const explained = contents
				.split('\n')
				.filter((line) => line.startsWith('#'))
				.some((line) => line.includes(entry));
			expect(explained, `${entry} is listed but never explained`).toBe(true);
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
		['a migration', 'apps/api/convex/migrations/0019_relay_kinds.ts'],
		['convex generated code', 'apps/api/convex/_generated/api.ts'],
	])('exempts %s', (_label, path) => {
		const root = sandbox({ files: { [path]: violation } });
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

	it('exempts the MTA, which speaks a different alphabet with the same spelling', () => {
		const root = sandbox({
			files: { 'apps/mta/src/routes/routingDecision.ts': leak("decision === 'mta'") },
		});
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});

	it('reaches the UI and the shared packages, not just the backend', () => {
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
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('FAIL: 3 file(s)');
		expect(result.output).toContain('apps/web/app/components/delivery/NewEditor.vue:2');
		expect(result.output).toContain('packages/shared/src/newRouting.ts');
		expect(result.output).toContain('apps/setup-cli/src/commands/newPrompt.ts');
		expect(result.status).toBe(1);
	});

	it('exempts a kind named inside a template comment', () => {
		const root = sandbox({
			files: {
				'apps/web/app/components/delivery/Documented.vue': [
					'<template>',
					'\t<!-- the credentials block used to be v-if="provider === \'ses\'" -->',
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

		expect(result.output).toContain('stale entr');
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

		expect(result.output).toContain('stale entr');
		expect(result.output).toContain('apps/api/convex/delivery/deleted.ts');
		expect(result.status).toBe(1);
	});

	it('fails when the allowlist file is missing', () => {
		const root = sandbox({ files: { 'apps/api/convex/delivery/clean.ts': leak('kind === OWN') } });
		rmSync(join(root, 'scripts/provider-identity-allowlist.txt'));
		const result = runIn(root);

		expect(result.output).toContain('is missing');
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
