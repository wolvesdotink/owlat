import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../check-format.sh');

function git(root: string, args: string[]): string {
	return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function write(root: string, path: string, contents = 'export const value = 1;\n'): void {
	const absolute = join(root, path);
	mkdirSync(resolve(absolute, '..'), { recursive: true });
	writeFileSync(absolute, contents);
}

describe('check-format changed-file ratchet', () => {
	it('deduplicates committed, staged, unstaged, and untracked source files', () => {
		const root = mkdtempSync(join(tmpdir(), 'owlat-format-ratchet-'));
		try {
			mkdirSync(join(root, 'scripts'), { recursive: true });
			mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
			copyFileSync(SCRIPT, join(root, 'scripts/check-format.sh'));
			writeFileSync(
				join(root, 'node_modules/.bin/oxfmt'),
				'#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n',
				{ mode: 0o755 }
			);

			git(root, ['init', '--quiet']);
			git(root, ['config', 'user.email', 'test@example.com']);
			git(root, ['config', 'user.name', 'Format Test']);
			write(root, 'baseline.ts');
			write(root, 'deleted.ts');
			git(root, ['add', '.']);
			git(root, ['commit', '--quiet', '-m', 'baseline']);
			const base = git(root, ['rev-parse', 'HEAD']);

			write(root, 'committed.ts');
			write(root, 'src/_generated/committed.ts');
			git(root, ['add', '.']);
			git(root, ['commit', '--quiet', '-m', 'branch change']);

			// This path is both committed and unstaged; it must reach oxfmt once.
			write(root, 'committed.ts', 'export const value = 2;\n');
			write(root, 'baseline.ts', 'export const value = 3;\n');
			write(root, 'staged.ts');
			git(root, ['add', 'staged.ts']);
			git(root, ['rm', '--quiet', 'deleted.ts']);
			write(root, 'untracked.ts');
			write(root, 'src/_generated/staged.ts');
			git(root, ['add', 'src/_generated/staged.ts']);
			write(root, 'src/_generated/untracked.ts');
			write(root, 'notes.md', '# ignored\n');

			const output = execFileSync('bash', ['scripts/check-format.sh'], {
				cwd: root,
				encoding: 'utf8',
				env: { ...process.env, OXFMT_BASE: base },
			});
			const formatterArgs = output.trim().split('\n').slice(1);

			expect(output).toContain('checking 4 changed file(s)');
			expect(formatterArgs).toEqual([
				'--config',
				'oxfmtrc.json',
				'--check',
				'baseline.ts',
				'committed.ts',
				'staged.ts',
				'untracked.ts',
			]);
			expect(output).not.toContain('_generated');
			expect(output).not.toContain('deleted.ts');
			expect(output).not.toContain('notes.md');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
