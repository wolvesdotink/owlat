/**
 * The member-jargon gate's own gate.
 *
 * The script names its member-visible surfaces and its exemptions as literal
 * paths, and both halves used to fail OPEN when one of those paths moved: a
 * missing root walks to an empty file list (the `readdir` rejection is caught),
 * and a missing allowlist entry excuses nothing while still reading like
 * sanctioned debt. Either way the gate prints nothing, so a rename is
 * indistinguishable from a clean surface. The cases below prove the gate still
 * catches jargon, still honours a live exemption, and now FAILS on a path that
 * has gone stale.
 *
 * Existence was only half of it. The allowlist is strict in BOTH directions now
 * — an entry whose file is still there but whose template has stopped saying any
 * jargon excuses nothing while pre-approving the regression that puts it back —
 * so the cases below also pin the ratchet's second direction, including the
 * difference between a template that went plain and a file the walk never read.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../check-member-jargon.ts');
const REPO_ROOT = resolve(import.meta.dirname, '../..');

const sandboxes: string[] = [];

afterEach(() => {
	while (sandboxes.length > 0) {
		const dir = sandboxes.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

type Result = { status: number; output: string };

/**
 * A miniature repository carrying the real script with its `roots` and
 * `allowlisted` literals rewritten to the ones the case is about. Rewriting
 * rather than re-implementing keeps the matcher, the template extraction and
 * the comment stripping under test.
 */
function run(options: {
	files: Record<string, string>;
	roots?: string[];
	allowlist?: string[];
}): Result {
	const root = mkdtempSync(join(tmpdir(), 'owlat-member-jargon-'));
	sandboxes.push(root);
	mkdirSync(join(root, 'scripts'), { recursive: true });

	let source = readFileSync(SCRIPT, 'utf8');
	if (options.roots) {
		source = source.replace(
			/const roots = \[[\s\S]*?\];/,
			`const roots = [\n${options.roots.map((path) => `\tjoin(workspace, '${path}'),`).join('\n')}\n];`
		);
	}
	if (options.allowlist) {
		source = source.replace(
			/const allowlisted = new Set\(\[[\s\S]*?\]\);/,
			`const allowlisted = new Set([\n${options.allowlist.map((path) => `\t'${path}',`).join('\n')}\n]);`
		);
	}
	writeFileSync(join(root, 'scripts/check-member-jargon.ts'), source);

	for (const [path, contents] of Object.entries(options.files)) {
		const absolute = join(root, path);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, contents);
	}

	const result = spawnSync('bun', ['scripts/check-member-jargon.ts'], {
		cwd: root,
		encoding: 'utf8',
	});
	return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

const PREFERENCES = 'apps/web/app/pages/dashboard/preferences';

/** A member-visible page whose template says `body`. */
function page(body: string): string {
	return ['<template>', '\t<div>', `\t\t${body}`, '\t</div>', '</template>', ''].join('\n');
}

describe('the member-jargon gate, on the repository it guards', () => {
	it('passes', () => {
		const result = spawnSync('bun', ['scripts/check-member-jargon.ts'], {
			cwd: REPO_ROOT,
			encoding: 'utf8',
		});
		expect(`${result.stdout}${result.stderr}`).toBe('');
		expect(result.status).toBe(0);
	});
});

describe('the member-jargon gate, stale configuration', () => {
	it('fails when an allowlisted file does not exist', () => {
		// The failure this test exists for. An entry naming a file that has been
		// renamed or deleted excuses nothing, and nothing said so: the gate stayed
		// green and the list kept documenting debt for a surface that had moved.
		const result = run({
			files: { [`${PREFERENCES}/aliases.vue`]: page('<p>Other addresses that reach you.</p>') },
			roots: [PREFERENCES],
			allowlist: [`${PREFERENCES}/gone.vue`],
		});

		expect(result.output).toContain('Stale member-jargon configuration');
		expect(result.output).toContain(`allowlist entry: ${PREFERENCES}/gone.vue`);
		expect(result.status).toBe(1);
	});

	it('fails when a member-visible root does not exist', () => {
		// The same silence from the other half: a root that has moved walks to an
		// empty list, so the surface it was pointing at stops being checked at all.
		const result = run({
			files: { [`${PREFERENCES}/aliases.vue`]: page('<p>Other addresses.</p>') },
			roots: [PREFERENCES, 'apps/web/app/components/postbox'],
			allowlist: [],
		});

		expect(result.output).toContain('member-visible root: apps/web/app/components/postbox');
		expect(result.status).toBe(1);
	});

	it('names the stale path instead of the jargon it was hiding', () => {
		// A stale entry must not be reported as a leak in whatever file happens to
		// still carry one — the remedy is a different edit.
		const result = run({
			files: { [`${PREFERENCES}/aliases.vue`]: page('<p>Set up SPF for this domain.</p>') },
			roots: [PREFERENCES],
			allowlist: [`${PREFERENCES}/gone.vue`],
		});

		expect(result.output).toContain('Stale member-jargon configuration');
		expect(result.output).not.toContain('Protocol jargon leaked');
		expect(result.status).toBe(1);
	});

	it('passes when every configured path is real', () => {
		const result = run({
			files: {
				[`${PREFERENCES}/aliases.vue`]: page('<p>Other addresses.</p>'),
				[`${PREFERENCES}/app-passwords.vue`]: page('<p>Use this in an IMAP client.</p>'),
			},
			roots: [PREFERENCES],
			allowlist: [`${PREFERENCES}/app-passwords.vue`],
		});

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});
});

describe('the member-jargon gate, unused exemptions', () => {
	it('fails when an allowlisted file has stopped saying any jargon', () => {
		// The other direction of the ratchet. The file is right there, so the
		// existence half is happy, and the entry still reads like sanctioned debt —
		// but the template it excuses now says it in plain words, so the line
		// excuses nothing and silently pre-approves putting the jargon back.
		const result = run({
			files: {
				[`${PREFERENCES}/app-passwords.vue`]: page('<p>Passwords for other mail apps.</p>'),
			},
			roots: [PREFERENCES],
			allowlist: [`${PREFERENCES}/app-passwords.vue`],
		});

		expect(result.output).toContain('Unused member-jargon exemption');
		expect(result.output).toContain(
			`${PREFERENCES}/app-passwords.vue (its member-visible template says none of it any more)`
		);
		expect(result.output).not.toContain('Protocol jargon leaked');
		expect(result.status).toBe(1);
	});

	it('keeps an exemption the file still needs', () => {
		// The half that must not become collateral damage: an entry pulling its
		// weight stays silent, jargon and all.
		const result = run({
			files: {
				[`${PREFERENCES}/app-passwords.vue`]: page('<p>Use this as your IMAP password.</p>'),
				[`${PREFERENCES}/aliases.vue`]: page('<p>Other addresses that reach you.</p>'),
			},
			roots: [PREFERENCES],
			allowlist: [`${PREFERENCES}/app-passwords.vue`],
		});

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it.each([
		[
			'a path under no member-visible root',
			'apps/web/app/components/postbox/PostboxSecurityBadge.vue',
			page('<p>Sealed with a verified DKIM signature.</p>'),
		],
		// The walk only reads `.vue`, so a listed sibling of another shape is not
		// jargon-free — it is unread, and the difference is what tells the reader
		// which edit to make.
		['a file the walk does not read', `${PREFERENCES}/app-passwords.md`, '# IMAP and SMTP\n'],
	])('fails on an exemption for %s, saying so', (_label, path, contents) => {
		const result = run({
			files: {
				[`${PREFERENCES}/aliases.vue`]: page('<p>Other addresses.</p>'),
				[path]: contents,
			},
			roots: [PREFERENCES],
			allowlist: [path],
		});

		expect(result.output).toContain('Unused member-jargon exemption');
		expect(result.output).toContain(`${path} (no member-visible root reaches it)`);
		expect(result.status).toBe(1);
	});

	it('reports a stale exemption and a real leak elsewhere together', () => {
		// Two verdicts out of one completed scan, and two independent edits. Hiding
		// either behind the other makes one fix take two runs to discover.
		const result = run({
			files: {
				[`${PREFERENCES}/app-passwords.vue`]: page('<p>Passwords for other mail apps.</p>'),
				[`${PREFERENCES}/aliases.vue`]: page('<p>Set up SPF for this domain.</p>'),
			},
			roots: [PREFERENCES],
			allowlist: [`${PREFERENCES}/app-passwords.vue`],
		});

		expect(result.output).toContain('Protocol jargon leaked');
		expect(result.output).toContain(`${PREFERENCES}/aliases.vue:3`);
		expect(result.output).toContain('Unused member-jargon exemption');
		expect(result.output).toContain(`${PREFERENCES}/app-passwords.vue`);
		expect(result.status).toBe(1);
	});
});

describe('the member-jargon gate, what it still catches', () => {
	it.each([['SPF'], ['DKIM'], ['DMARC'], ['IMAP'], ['SMTP'], ['MX record'], ['MX records']])(
		'fails on %s in a member-visible template',
		(term) => {
			const result = run({
				files: { [`${PREFERENCES}/aliases.vue`]: page(`<p>Check your ${term} settings.</p>`) },
				roots: [PREFERENCES],
				allowlist: [],
			});

			expect(result.output).toContain('Protocol jargon leaked');
			expect(result.output).toContain(`${PREFERENCES}/aliases.vue:3`);
			expect(result.status).toBe(1);
		}
	);

	it('passes the same jargon in an allowlisted file', () => {
		const result = run({
			files: { [`${PREFERENCES}/aliases.vue`]: page('<p>Point SMTP here.</p>') },
			roots: [PREFERENCES],
			allowlist: [`${PREFERENCES}/aliases.vue`],
		});

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it.each([
		['the script block', 'const SMTP_PORT = 587; // SPF and DKIM are checked server-side'],
		['a template comment', '<!-- the DMARC verdict used to be rendered here -->'],
	])('passes jargon in %s, which no member reads', (_label, text) => {
		const source = text.startsWith('<!--')
			? page(text)
			: ['<script setup lang="ts">', text, '</script>', '', page('<p>All good.</p>')].join('\n');
		const result = run({
			files: { [`${PREFERENCES}/aliases.vue`]: source },
			roots: [PREFERENCES],
			allowlist: [],
		});

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it('reads jargon inside a nested template branch', () => {
		// The bug the both-directions ratchet uncovered: the extractor stopped at the
		// FIRST `</template>`, which in a Vue SFC is a nested `<template v-if>` and
		// not the end of the surface. PostboxMailboxMove.vue was read to line 166 of
		// 390 and its four member-visible `MX record` strings were invisible — so a
		// conditional branch was the place to put jargon and stay green.
		const source = [
			'<template>',
			'\t<div>',
			'\t\t<template v-if="pending">',
			'\t\t\t<p>Almost there.</p>',
			'\t\t</template>',
			'\t\t<template v-else>',
			'\t\t\t<p>Publish this MX record.</p>',
			'\t\t</template>',
			'\t</div>',
			'</template>',
			'',
		].join('\n');
		const result = run({
			files: { [`${PREFERENCES}/aliases.vue`]: source },
			roots: [PREFERENCES],
			allowlist: [],
		});

		expect(result.output).toContain('Protocol jargon leaked');
		expect(result.output).toContain(`${PREFERENCES}/aliases.vue:7`);
		expect(result.status).toBe(1);
	});

	it('numbers a hit by its line in the file, not in the template', () => {
		// Almost every real surface opens with `<script setup>`, so a template-relative
		// number sends the reader dozens of lines short of the line to edit.
		const source = [
			'<script setup lang="ts">',
			'const pending = false;',
			'</script>',
			'',
			...page('<p>Enter your IMAP host.</p>').split('\n'),
		].join('\n');
		const result = run({
			files: { [`${PREFERENCES}/aliases.vue`]: source },
			roots: [PREFERENCES],
			allowlist: [],
		});

		expect(result.output).toContain(`${PREFERENCES}/aliases.vue:7: <p>Enter your IMAP host.</p>`);
		expect(result.status).toBe(1);
	});

	it('numbers a hit under a multi-line comment by its real line', () => {
		// Comments are blanked rather than deleted, so a comment that spans lines
		// does not renumber everything below it.
		const source = [
			'<template>',
			'\t<div>',
			'\t\t<!--',
			'\t\t\tthe DMARC verdict used to be rendered here',
			'\t\t-->',
			'\t\t<p>Enter your IMAP host.</p>',
			'\t</div>',
			'</template>',
			'',
		].join('\n');
		const result = run({
			files: { [`${PREFERENCES}/aliases.vue`]: source },
			roots: [PREFERENCES],
			allowlist: [],
		});

		expect(result.output).toContain(`${PREFERENCES}/aliases.vue:6: <p>Enter your IMAP host.</p>`);
		expect(result.output).not.toContain('DMARC');
		expect(result.status).toBe(1);
	});

	it('reads a root that names a single file, not only a directory', () => {
		const result = run({
			files: {
				'apps/web/app/pages/dashboard/postbox/migrate.vue': page('<p>Enter your IMAP host.</p>'),
			},
			roots: ['apps/web/app/pages/dashboard/postbox/migrate.vue'],
			allowlist: [],
		});

		expect(result.output).toContain('apps/web/app/pages/dashboard/postbox/migrate.vue:3');
		expect(result.status).toBe(1);
	});
});
