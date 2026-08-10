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
