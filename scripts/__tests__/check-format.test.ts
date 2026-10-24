import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCommentPolicy } from '../check-comment-policy';

const SCRIPT = resolve(import.meta.dirname, '../check-format.sh');

function git(root: string, args: string[]): string {
	return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function write(root: string, path: string, contents = 'export const value = 1;\n'): void {
	const absolute = join(root, path);
	mkdirSync(resolve(absolute, '..'), { recursive: true });
	writeFileSync(absolute, contents);
}

function formatEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env['CI'];
	delete env['GITHUB_BASE_REF'];
	delete env['GITHUB_ENV'];
	delete env['OXFMT_BASE'];
	delete env['PR_BASE_SHA'];
	return { ...env, ...overrides };
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
				env: formatEnv({ OXFMT_BASE: base }),
			});
			const formatterArgs = output.trim().split('\n').slice(1);

			expect(output).toContain('checking 4 changed file(s)');
			expect(formatterArgs).toEqual([
				'--config',
				'oxfmtrc.json',
				'--check',
				'--',
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

	it('passes paths Git would quote to oxfmt unchanged', () => {
		const root = mkdtempSync(join(tmpdir(), 'owlat-format-names-'));
		try {
			mkdirSync(join(root, 'scripts'), { recursive: true });
			mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
			copyFileSync(SCRIPT, join(root, 'scripts/check-format.sh'));
			// One argument per NUL-terminated record, so a newline in a name shows.
			writeFileSync(
				join(root, 'node_modules/.bin/oxfmt'),
				'#!/usr/bin/env bash\nprintf "%s\\0" "$@"\n',
				{ mode: 0o755 }
			);

			git(root, ['init', '--quiet']);
			git(root, ['config', 'user.email', 'test@example.com']);
			git(root, ['config', 'user.name', 'Format Test']);
			git(root, ['config', 'core.quotePath', 'true']);
			write(root, 'baseline.ts');
			git(root, ['add', '.']);
			git(root, ['commit', '--quiet', '-m', 'baseline']);
			const base = git(root, ['rev-parse', 'HEAD']);

			const names = ['-dash.ts', 'quote".ts', 'space name.ts', 'tab\tname.ts', 'unformatted ü.ts'];
			for (const name of names.slice(0, 3)) write(root, name);
			git(root, ['add', '.']);
			git(root, ['commit', '--quiet', '-m', 'odd names']);
			write(root, names[3]!);
			git(root, ['add', '.']);
			write(root, names[4]!);

			const output = execFileSync('bash', ['scripts/check-format.sh'], {
				cwd: root,
				encoding: 'utf8',
				env: formatEnv({ OXFMT_BASE: base }),
			});
			const [header, ...rest] = output.split('\n');
			const formatterArgs = rest.join('\n').split('\0').slice(0, -1);

			expect(header).toBe(`check-format: checking ${names.length} changed file(s) with oxfmt...`);
			expect(formatterArgs).toEqual(['--config', 'oxfmtrc.json', '--check', '--', ...names]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('uses the fetched pull-request base in a hermetic CI-shaped repository', () => {
		const sandbox = mkdtempSync(join(tmpdir(), 'owlat-format-ci-base-'));
		const root = join(sandbox, 'repo');
		const origin = join(sandbox, 'origin.git');
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
			git(root, ['add', '.']);
			git(root, ['commit', '--quiet', '-m', 'baseline']);
			git(root, ['branch', '-M', 'main']);
			git(sandbox, ['init', '--bare', '--quiet', origin]);
			git(root, ['remote', 'add', 'origin', origin]);
			git(root, ['push', '--quiet', '-u', 'origin', 'main']);

			git(root, ['checkout', '--quiet', '-b', 'feature']);
			write(root, 'feature.ts');
			git(root, ['add', 'feature.ts']);
			git(root, ['commit', '--quiet', '-m', 'feature']);

			const output = execFileSync('bash', ['scripts/check-format.sh'], {
				cwd: root,
				encoding: 'utf8',
				env: formatEnv({
					GITHUB_BASE_REF: 'main',
					GITHUB_ENV: join(sandbox, 'github-env'),
					OXFMT_BASE: 'must-not-win',
				}),
			});

			expect(output).toContain('checking 1 changed file(s)');
			expect(output.trim().split('\n').slice(1)).toEqual([
				'--config',
				'oxfmtrc.json',
				'--check',
				'--',
				'feature.ts',
			]);
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});
});

/**
 * The Lint job of a pull request: a full clone (fetch-depth: 0) of a remote
 * whose main moves after the checkout, then the base-diffing gates in the
 * order ci:lint runs them.
 */
describe('a pull request whose target branch moves during the job', () => {
	interface Race {
		sandbox: string;
		root: string;
		base: string;
		moved: string;
	}

	function race(clone: string[] = []): Race {
		const sandbox = mkdtempSync(join(tmpdir(), 'owlat-format-race-'));
		const seed = join(sandbox, 'seed');
		const origin = join(sandbox, 'origin.git');
		const root = join(sandbox, 'repo');
		mkdirSync(seed);
		git(seed, ['init', '--quiet', '--initial-branch', 'main']);
		git(seed, ['config', 'user.email', 'test@example.com']);
		git(seed, ['config', 'user.name', 'Format Test']);
		write(seed, 'baseline.ts');
		git(seed, ['add', '.']);
		git(seed, ['commit', '--quiet', '-m', 'baseline']);
		const base = git(seed, ['rev-parse', 'HEAD']);
		git(seed, ['checkout', '--quiet', '-b', 'feature']);
		write(seed, 'feature.ts');
		git(seed, ['add', '.']);
		git(seed, ['commit', '--quiet', '-m', 'feature']);
		git(sandbox, ['clone', '--quiet', '--bare', seed, origin]);

		execFileSync('git', ['clone', '--quiet', ...clone, `file://${origin}`, root]);
		git(root, ['config', 'user.email', 'test@example.com']);
		git(root, ['config', 'user.name', 'Format Test']);
		git(root, ['checkout', '--quiet', 'feature']);
		// The gate and its stand-in formatter are scaffolding, not the change.
		writeFileSync(join(root, '.git/info/exclude'), 'scripts/\nnode_modules/\n');
		mkdirSync(join(root, 'scripts'));
		mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
		copyFileSync(SCRIPT, join(root, 'scripts/check-format.sh'));
		writeFileSync(
			join(root, 'node_modules/.bin/oxfmt'),
			'#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n',
			{ mode: 0o755 }
		);

		// main moves on the remote after the checkout.
		git(seed, ['checkout', '--quiet', 'main']);
		write(seed, 'later.ts');
		git(seed, ['add', '.']);
		git(seed, ['commit', '--quiet', '-m', 'later']);
		git(seed, ['push', '--quiet', origin, 'main']);
		return { sandbox, root, base, moved: git(seed, ['rev-parse', 'HEAD']) };
	}

	const runFormat = (root: string, env: NodeJS.ProcessEnv) =>
		spawnSync('bash', ['scripts/check-format.sh'], {
			cwd: root,
			encoding: 'utf8',
			env: formatEnv({ CI: 'true', GITHUB_BASE_REF: 'main', ...env }),
		});

	it.each([
		['pinned to PR_BASE_SHA', true],
		['against origin/main', false],
	])('keeps the history and the base for every later gate (%s)', (_name, pin) => {
		const { sandbox, root, base } = race();
		try {
			const before = git(root, ['rev-parse', 'origin/main']);
			const env = pin ? { PR_BASE_SHA: base } : {};
			const format = runFormat(root, env);

			expect(format.status, format.stderr).toBe(0);
			expect(format.stdout).toContain('checking 1 changed file(s)');
			expect(format.stdout.trim().split('\n').at(-1)).toBe('feature.ts');
			expect(git(root, ['rev-parse', '--is-shallow-repository'])).toBe('false');
			expect(git(root, ['rev-parse', 'origin/main'])).toBe(before);

			const policy = checkCommentPolicy(root, { CI: 'true', GITHUB_BASE_REF: 'main', ...env });
			expect(policy.status, policy.messages.join('\n')).toBe(0);
			expect(policy.messages.at(-1)).toContain('1 changed file(s) against origin/main');
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});

	it('fetches a pinned base a single-branch shallow checkout lacks, with its history', () => {
		const { sandbox, root, base } = race(['--depth=1', '--single-branch', '--branch', 'feature']);
		try {
			expect(git(root, ['rev-parse', '--is-shallow-repository'])).toBe('true');
			const format = runFormat(root, { PR_BASE_SHA: base });
			expect(format.status, format.stderr).toBe(0);
			expect(format.stdout.trim().split('\n').at(-1)).toBe('feature.ts');
			expect(git(root, ['merge-base', base, 'HEAD'])).toBe(base);
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});

	it('fails in CI, and skips locally, when the base cannot be fetched', () => {
		const { sandbox, root, base } = race(['--depth=1', '--single-branch', '--branch', 'feature']);
		try {
			git(root, ['remote', 'remove', 'origin']);
			for (const env of [{}, { PR_BASE_SHA: base }]) {
				const ci = runFormat(root, env);
				expect(ci.status).toBe(1);
				expect(ci.stderr).toContain('not found');

				const local = runFormat(root, { CI: '', ...env });
				expect(local.status).toBe(0);
				expect(local.stdout).toContain('skipping outside CI');
			}
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});

	it('fails in CI, and skips locally, when HEAD has no merge base with the base', () => {
		const { sandbox, root, moved } = race(['--depth=1', '--single-branch', '--branch', 'feature']);
		try {
			git(root, ['fetch', '--quiet', '--depth=1', 'origin', moved]);
			git(root, ['remote', 'remove', 'origin']);
			const ci = runFormat(root, { PR_BASE_SHA: moved });
			expect(ci.status).toBe(1);
			expect(ci.stderr).toContain('no merge base');

			const local = runFormat(root, { CI: '', PR_BASE_SHA: moved });
			expect(local.status).toBe(0);
			expect(local.stdout).toContain('skipping outside CI');
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});
});
