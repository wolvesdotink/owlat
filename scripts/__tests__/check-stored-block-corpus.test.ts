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

function check(root: string, base: string): { status: number; output: string } {
	const env: NodeJS.ProcessEnv = { ...process.env, STORED_BLOCK_CORPUS_BASE: base };
	delete env['GITHUB_BASE_REF'];
	const result = spawnSync('bun', ['scripts/check-stored-block-corpus.ts'], {
		cwd: root,
		encoding: 'utf8',
		env,
	});
	return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
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
});
