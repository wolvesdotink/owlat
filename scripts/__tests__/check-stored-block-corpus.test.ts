import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../check-stored-block-corpus.ts');
const CORPUS = 'packages/email-renderer/src/__tests__/storedBlocks';
const VERSION_FILE = 'packages/email-renderer/src/version.ts';

const sandboxes: string[] = [];

afterEach(() => {
	while (sandboxes.length > 0) {
		const dir = sandboxes.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function git(root: string, args: string[]): string {
	return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function write(root: string, path: string, contents: string): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), contents);
}

/**
 * A miniature repository whose base commit holds one v1 fixture, its renderer
 * v2 snapshot and `retired.json`; returns it with the base commit's sha.
 */
function repository(): { root: string; base: string } {
	const root = mkdtempSync(join(tmpdir(), 'owlat-stored-block-corpus-'));
	sandboxes.push(root);
	mkdirSync(join(root, 'scripts'), { recursive: true });
	copyFileSync(SCRIPT, join(root, 'scripts/check-stored-block-corpus.ts'));
	git(root, ['init', '--quiet']);
	git(root, ['config', 'user.email', 'test@example.com']);
	git(root, ['config', 'user.name', 'Corpus Test']);
	write(root, VERSION_FILE, 'export const EMAIL_RENDERER_VERSION = 2;\n');
	write(root, `${CORPUS}/retired.json`, '{}\n');
	write(root, `${CORPUS}/v1/a.json`, '{"stored": []}\n');
	write(root, `${CORPUS}/snapshots/renderer-v2/a.html`, '<html>a</html>');
	git(root, ['add', '.']);
	git(root, ['commit', '--quiet', '-m', 'base']);
	return { root, base: git(root, ['rev-parse', 'HEAD']) };
}

type Result = { status: number; output: string };

/** Variables the gate reads; cleared so the runner's own CI state never leaks in. */
const GATE_ENV = [
	'CI',
	'GITHUB_ACTIONS',
	'GITHUB_BASE_REF',
	'STORED_BLOCK_CORPUS_BASE',
	'STORED_BLOCK_CORPUS_PUSH_BEFORE',
];

function run(root: string, overrides: Record<string, string>): Result {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const name of GATE_ENV) delete env[name];
	const result = spawnSync('bun', ['scripts/check-stored-block-corpus.ts'], {
		cwd: root,
		encoding: 'utf8',
		env: { ...env, ...overrides },
	});
	return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

const check = (root: string, base: string): Result => run(root, { STORED_BLOCK_CORPUS_BASE: base });

/** A CI push event, as the Lint job in .github/workflows/test.yml runs the gate. */
const ciPush = (root: string, before: string): Result =>
	run(root, { CI: 'true', GITHUB_ACTIONS: 'true', STORED_BLOCK_CORPUS_PUSH_BEFORE: before });

/** The base repository plus one commit that rewrites the snapshot in place. */
function rewrittenOnTop(): { root: string; base: string } {
	const repo = repository();
	write(repo.root, `${CORPUS}/snapshots/renderer-v2/a.html`, '<html>changed</html>');
	git(repo.root, ['commit', '--quiet', '-am', 'rewrite']);
	return repo;
}

/** A depth-1 clone of `source`: HEAD only, the base commit missing. */
function shallowClone(source: string): string {
	const root = mkdtempSync(join(tmpdir(), 'owlat-stored-block-corpus-shallow-'));
	sandboxes.push(root);
	execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${source}`, root]);
	return root;
}

describe('check-stored-block-corpus', () => {
	it('accepts a new fixture with its snapshot', () => {
		const { root, base } = repository();
		write(root, `${CORPUS}/v1/b.json`, '{"stored": []}\n');
		write(root, `${CORPUS}/snapshots/renderer-v2/b.html`, '<html>b</html>');
		expect(check(root, base).status).toBe(0);
	});

	it('refuses a snapshot rewritten in place, committed or not', () => {
		const { root, base } = repository();
		write(root, `${CORPUS}/snapshots/renderer-v2/a.html`, '<html>changed</html>');
		const result = check(root, base);
		expect(result.status).toBe(1);
		expect(result.output).toContain('snapshots/renderer-v2/a.html');

		git(root, ['commit', '--quiet', '-am', 'rewrite']);
		expect(check(root, base).status).toBe(1);
	});

	it('refuses an edited fixture', () => {
		const { root, base } = repository();
		write(root, `${CORPUS}/v1/a.json`, '{"stored": [{}]}\n');
		const result = check(root, base);
		expect(result.status).toBe(1);
		expect(result.output).toContain('v1/a.json');
	});

	it('accepts a renderer version bump that moves the snapshots to a new directory', () => {
		const { root, base } = repository();
		write(root, VERSION_FILE, 'export const EMAIL_RENDERER_VERSION = 3;\n');
		rmSync(join(root, CORPUS, 'snapshots/renderer-v2'), { recursive: true });
		write(root, `${CORPUS}/snapshots/renderer-v3/a.html`, '<html>a, rendered by v3</html>');
		expect(check(root, base).status).toBe(0);
	});

	it('refuses a deleted snapshot without a bump or its fixture going', () => {
		const { root, base } = repository();
		rmSync(join(root, CORPUS, 'snapshots/renderer-v2/a.html'));
		expect(check(root, base).status).toBe(1);
	});

	it('lets a fixture go only with its contentBlockVersion retired', () => {
		const { root, base } = repository();
		rmSync(join(root, CORPUS, 'v1/a.json'));
		rmSync(join(root, CORPUS, 'snapshots/renderer-v2/a.html'));
		const result = check(root, base);
		expect(result.status).toBe(1);
		expect(result.output).toContain('retired.json');

		write(root, `${CORPUS}/retired.json`, '{ "1": "migrations/0099_retire_v1_blocks.ts" }\n');
		expect(check(root, base).status).toBe(0);
	});

	describe('push events in CI', () => {
		it('compares a push with the commit before it, even when origin/main is HEAD', () => {
			const { root, base } = rewrittenOnTop();
			git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
			const result = ciPush(root, base);
			expect(result.status).toBe(1);
			expect(result.output).toContain('snapshots/renderer-v2/a.html');
		});

		it("falls back to HEAD's parent when the before sha is all zeros or missing", () => {
			const { root } = rewrittenOnTop();
			expect(ciPush(root, '0000000000000000000000000000000000000000').status).toBe(1);
			expect(ciPush(root, '').status).toBe(1);
		});

		it('compares a root commit with the empty tree', () => {
			const { root } = repository();
			const result = ciPush(root, '');
			expect(result.status).toBe(0);
			expect(result.output).toContain('3 corpus change(s)');
		});

		it('fetches the history a shallow checkout lacks', () => {
			const { root: source, base } = rewrittenOnTop();
			const root = shallowClone(source);
			const result = ciPush(root, base);
			expect(result.status).toBe(1);
			expect(result.output).toContain('snapshots/renderer-v2/a.html');
		});
	});

	describe('a base it cannot resolve', () => {
		it('fails in CI and warns locally when the target branch is unavailable', () => {
			const { root } = rewrittenOnTop();
			const ci = run(root, { CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_BASE_REF: 'main' });
			expect(ci.status).toBe(1);
			expect(ci.output).toContain('cannot resolve the base origin/main');

			const local = run(root, { GITHUB_BASE_REF: 'main' });
			expect(local.status).toBe(0);
			expect(local.output).toContain('skipping outside CI');
		});

		it('fails in CI when a shallow checkout cannot fetch the missing history', () => {
			const { root: source, base } = rewrittenOnTop();
			const root = shallowClone(source);
			git(root, ['remote', 'remove', 'origin']);
			for (const before of [base, '']) {
				const result = ciPush(root, before);
				expect(result.status).toBe(1);
				expect(result.output).toContain('cannot resolve the base');
			}
			expect(run(root, { STORED_BLOCK_CORPUS_PUSH_BEFORE: base }).status).toBe(0);
		});
	});
});
