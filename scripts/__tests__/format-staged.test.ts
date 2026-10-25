/**
 * The pre-commit formatter (scripts/format-staged.ts) and its installer
 * (scripts/install-git-hooks.ts), exercised end to end: each test builds a
 * temporary repository, installs the real hook and commits through git, with
 * the real oxfmt binary.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FORMAT_PATHSPECS } from '../format-staged';
import { NO_AUTO_MAINTENANCE } from './gitRepository.testlib';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');
const OXFMT = realpathSync(join(REPOSITORY_ROOT, 'node_modules/.bin/oxfmt'));
const COPIED = ['scripts/format-staged.ts', 'scripts/install-git-hooks.ts', 'oxfmtrc.json'];

const UNFORMATTED = 'const a = "x"\n';
const FORMATTED = "const a = 'x';\n";

const parents: string[] = [];
afterEach(() => {
	for (const parent of parents.splice(0)) rmSync(parent, { recursive: true, force: true });
});

// Hooks inherit the caller's environment: drop any GIT_* variables (a test run
// started from inside a hook would otherwise point git at the outer index) and
// ignore the developer's global and system git config.
function gitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith('GIT_')) env[key] = value;
	}
	return { ...env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' };
}

function run(
	cwd: string,
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv = gitEnv()
): SpawnSyncReturns<string> {
	return spawnSync(command, args, { cwd, encoding: 'utf8', env });
}

function git(cwd: string, args: string[]): string {
	const result = run(cwd, 'git', args);
	if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
	return result.stdout;
}

function write(root: string, path: string, contents: string): void {
	const absolute = join(root, path);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents);
}

function read(root: string, path: string): string {
	return readFileSync(join(root, path), 'utf8');
}

function linkOxfmt(root: string): void {
	mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
	symlinkSync(OXFMT, join(root, 'node_modules/.bin/oxfmt'));
}

function executable(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
	chmodSync(path, 0o755);
}

function copyScripts(root: string): void {
	for (const path of COPIED) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		copyFileSync(join(REPOSITORY_ROOT, path), join(root, path));
	}
}

/** A repository with the formatter scripts copied in (not committed) and oxfmt linked. */
function repository(): { parent: string; root: string } {
	const parent = mkdtempSync(join(tmpdir(), 'owlat-format-staged-'));
	parents.push(parent);
	const root = join(parent, 'main');
	mkdirSync(root);
	git(root, ['init', '--quiet', '--initial-branch=main']);
	git(root, ['config', 'user.email', 'test@example.com']);
	git(root, ['config', 'user.name', 'Format Test']);
	git(root, [...NO_AUTO_MAINTENANCE]);
	write(root, '.gitignore', 'node_modules/\n');
	copyScripts(root);
	linkOxfmt(root);
	return { parent, root };
}

function installHook(root: string): void {
	const result = run(root, 'bun', ['scripts/install-git-hooks.ts']);
	expect(result.status, result.stderr).toBe(0);
}

function commit(root: string, args: string[] = []): SpawnSyncReturns<string> {
	return run(root, 'git', ['commit', '--quiet', '-m', 'change', ...args]);
}

function commitOk(root: string, args: string[] = []): string {
	const result = commit(root, args);
	expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	return result.stdout + result.stderr;
}

/** Commits the scripts so later commits start from a clean, formatted tree. */
function baseline(root: string): void {
	git(root, ['add', '.']);
	commitOk(root);
}

describe('format-staged pre-commit hook', () => {
	it('formats the staged files of the first commit and the working tree with them', () => {
		const { root } = repository();
		installHook(root);
		write(root, 'src/a.ts', UNFORMATTED);
		git(root, ['add', '.']);

		const output = commitOk(root);

		expect(output).toContain('format-staged: formatted 1 staged file(s)');
		expect(git(root, ['show', 'HEAD:src/a.ts'])).toBe(FORMATTED);
		expect(read(root, 'src/a.ts')).toBe(FORMATTED);
		expect(git(root, ['status', '--porcelain'])).toBe('');
	});

	it('commits only the formatted staged version and keeps unstaged and untracked bytes', () => {
		const { root } = repository();
		installHook(root);
		write(root, 'partial.ts', FORMATTED);
		write(root, 'unstaged.ts', FORMATTED);
		baseline(root);

		// Partially staged: the index holds one version, the working tree another.
		write(root, 'partial.ts', 'const staged = "s"\n');
		git(root, ['add', 'partial.ts']);
		const partialWorktree = 'const staged = "s"\nconst unstaged   =  "u"\n';
		write(root, 'partial.ts', partialWorktree);
		write(root, 'unstaged.ts', UNFORMATTED);
		write(root, 'untracked.ts', UNFORMATTED);

		commitOk(root);

		expect(git(root, ['show', 'HEAD:partial.ts'])).toBe("const staged = 's';\n");
		expect(read(root, 'partial.ts')).toBe(partialWorktree);
		expect(git(root, ['show', 'HEAD:unstaged.ts'])).toBe(FORMATTED);
		expect(read(root, 'unstaged.ts')).toBe(UNFORMATTED);
		expect(read(root, 'untracked.ts')).toBe(UNFORMATTED);
		expect(git(root, ['ls-files', 'untracked.ts'])).toBe('');
	});

	it('formats unusual paths, keeps file modes, and skips generated, non-JS and symlinked files', () => {
		const { root } = repository();
		installHook(root);
		baseline(root);
		const odd = 'dir with space/we"ird\nname.ts';
		write(root, odd, UNFORMATTED);
		write(root, 'bin/run.mjs', 'console.log("run")\n');
		chmodSync(join(root, 'bin/run.mjs'), 0o755);
		write(root, 'apps/api/convex/_generated/api.ts', UNFORMATTED);
		write(root, 'notes.md', '#  Title\n');
		symlinkSync('target"x".ts', join(root, 'link.ts'));
		git(root, ['add', '.']);

		commitOk(root);

		expect(git(root, ['show', `HEAD:${odd}`])).toBe(FORMATTED);
		expect(read(root, odd)).toBe(FORMATTED);
		expect(git(root, ['show', 'HEAD:bin/run.mjs'])).toBe("console.log('run');\n");
		expect(git(root, ['ls-files', '-s', 'bin/run.mjs'])).toMatch(/^100755 /);
		expect(git(root, ['show', 'HEAD:apps/api/convex/_generated/api.ts'])).toBe(UNFORMATTED);
		expect(git(root, ['show', 'HEAD:notes.md'])).toBe('#  Title\n');
		expect(git(root, ['ls-files', '-s', 'link.ts'])).toMatch(/^120000 /);
		expect(git(root, ['show', 'HEAD:link.ts'])).toBe('target"x".ts');
		expect(git(root, ['status', '--porcelain'])).toBe('');
	});

	it('formats tracked files committed with -a through the temporary index', () => {
		const { root } = repository();
		installHook(root);
		write(root, 'a.ts', FORMATTED);
		baseline(root);
		write(root, 'a.ts', 'const a = "changed"\n');

		commitOk(root, ['-a']);

		expect(git(root, ['show', 'HEAD:a.ts'])).toBe("const a = 'changed';\n");
		expect(read(root, 'a.ts')).toBe("const a = 'changed';\n");
		expect(git(root, ['status', '--porcelain'])).toBe('');
	});

	it('formats files committed by path in the commit, the index and the working tree', () => {
		const { root } = repository();
		installHook(root);
		write(root, 'a.ts', FORMATTED);
		write(root, 'b.ts', FORMATTED);
		baseline(root);
		write(root, 'a.ts', 'const a = "path"\n');
		write(root, 'b.ts', UNFORMATTED.replace('x', 'left out'));

		commitOk(root, ['--', 'a.ts']);

		expect(git(root, ['show', 'HEAD:a.ts'])).toBe("const a = 'path';\n");
		expect(git(root, ['show', ':a.ts'])).toBe("const a = 'path';\n");
		expect(read(root, 'a.ts')).toBe("const a = 'path';\n");
		expect(git(root, ['status', '--porcelain'])).toBe(' M b.ts\n');
	});

	it('refuses the commit and changes nothing when oxfmt rejects a staged file', () => {
		const { root } = repository();
		installHook(root);
		baseline(root);
		const head = git(root, ['rev-parse', 'HEAD']);
		write(root, 'a.ts', UNFORMATTED);
		write(root, 'broken.ts', 'const broken = (\n');
		git(root, ['add', '.']);
		const index = git(root, ['ls-files', '-s']);

		const result = commit(root);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('broken.ts');
		expect(result.stderr).toContain('Nothing was changed');
		expect(git(root, ['rev-parse', 'HEAD'])).toBe(head);
		expect(git(root, ['ls-files', '-s'])).toBe(index);
		expect(read(root, 'a.ts')).toBe(UNFORMATTED);
	});

	it('refuses the commit when oxfmt returns nothing for a non-empty file', () => {
		const { root } = repository();
		installHook(root);
		baseline(root);
		const head = git(root, ['rev-parse', 'HEAD']);
		// A formatter whose input never arrived: it reads nothing and exits 0.
		rmSync(join(root, 'node_modules/.bin/oxfmt'));
		executable(join(root, 'node_modules/.bin/oxfmt'), '#!/bin/sh\ncat >/dev/null\nexit 0\n');
		write(root, 'a.ts', UNFORMATTED);
		write(root, 'empty.ts', '\n');
		git(root, ['add', '.']);
		const index = git(root, ['ls-files', '-s']);

		const result = commit(root);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('a.ts: oxfmt returned no output for a non-empty file');
		expect(result.stderr).not.toContain('empty.ts');
		expect(git(root, ['rev-parse', 'HEAD'])).toBe(head);
		expect(git(root, ['ls-files', '-s'])).toBe(index);
		expect(read(root, 'a.ts')).toBe(UNFORMATTED);
	});

	it('keeps an edit saved while the index is being updated', () => {
		const { parent, root } = repository();
		baseline(root);
		write(root, 'a.ts', UNFORMATTED);
		git(root, ['add', 'a.ts']);
		// A git on PATH that saves a.ts the moment the formatter stages its blobs,
		// the way an editor saving mid-commit would.
		const realGit = run(root, 'sh', ['-c', 'command -v git']).stdout.trim();
		const saved = 'const saved = "editor"\n';
		executable(
			join(parent, 'bin/git'),
			`#!/bin/sh\nif [ "$1" = update-index ]; then printf '%s' '${saved}' > a.ts; fi\nexec '${realGit}' "$@"\n`
		);
		const env = { ...gitEnv(), PATH: `${join(parent, 'bin')}:${process.env['PATH']}` };

		const result = run(root, 'bun', ['scripts/format-staged.ts'], env);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain('Unstaged edits kept');
		expect(git(root, ['show', ':a.ts'])).toBe(FORMATTED);
		expect(read(root, 'a.ts')).toBe(saved);
	});

	it('leaves a merge commit as the merge produced it', () => {
		const { root } = repository();
		installHook(root);
		baseline(root);
		git(root, ['checkout', '--quiet', '-b', 'other']);
		write(root, 'incoming.ts', UNFORMATTED);
		git(root, ['add', '.']);
		commitOk(root, ['--no-verify']);
		git(root, ['checkout', '--quiet', 'main']);
		git(root, ['merge', '--quiet', '--no-ff', '--no-commit', 'other']);

		commitOk(root);

		expect(git(root, ['show', 'HEAD:incoming.ts'])).toBe(UNFORMATTED);
		expect(git(root, ['rev-list', '--parents', '-n1', 'HEAD']).trim().split(' ')).toHaveLength(3);
	});

	it('runs each linked worktree its own formatter, and none on a branch without it', () => {
		const { parent, root } = repository();
		// A branch cut before the formatter existed.
		write(root, 'README.md', '# repo\n');
		git(root, ['add', 'README.md', '.gitignore']);
		commitOk(root);
		git(root, ['branch', 'old']);
		baseline(root);
		installHook(root);

		const feature = join(parent, 'feature');
		git(root, ['worktree', 'add', '--quiet', '-b', 'feature', feature]);
		linkOxfmt(feature);
		write(feature, 'f.ts', UNFORMATTED);
		git(feature, ['add', 'f.ts']);
		commitOk(feature);
		expect(git(feature, ['show', 'HEAD:f.ts'])).toBe(FORMATTED);
		expect(read(feature, 'f.ts')).toBe(FORMATTED);
		expect(git(root, ['status', '--porcelain'])).toBe('');

		const old = join(parent, 'old');
		git(root, ['worktree', 'add', '--quiet', old, 'old']);
		write(old, 'o.ts', UNFORMATTED);
		git(old, ['add', 'o.ts']);
		commitOk(old);
		expect(git(old, ['show', 'HEAD:o.ts'])).toBe(UNFORMATTED);
	});
});

describe('install-git-hooks', () => {
	const hookFile = (root: string) => join(root, '.git/hooks/pre-commit');

	it('installs idempotently and uninstalls its own hook', () => {
		const { root } = repository();
		installHook(root);
		installHook(root);
		expect(read(root, '.git/hooks/pre-commit')).toContain('# owlat-managed pre-commit hook');

		const result = run(root, 'bun', ['scripts/install-git-hooks.ts', '--uninstall']);
		expect(result.status, result.stderr).toBe(0);
		expect(() => readFileSync(hookFile(root))).toThrow();
	});

	it('never replaces or removes a pre-commit hook it did not write', () => {
		const { root } = repository();
		const custom = '#!/bin/sh\necho custom\n';
		mkdirSync(dirname(hookFile(root)), { recursive: true });
		writeFileSync(hookFile(root), custom);

		const install = run(root, 'bun', ['scripts/install-git-hooks.ts']);
		expect(install.status).toBe(1);
		expect(install.stderr).toContain('bun scripts/format-staged.ts');
		const uninstall = run(root, 'bun', ['scripts/install-git-hooks.ts', '--uninstall']);
		expect(uninstall.status).toBe(1);
		expect(read(root, '.git/hooks/pre-commit')).toBe(custom);
	});

	it('leaves a clone with core.hooksPath alone', () => {
		const { root } = repository();
		git(root, ['config', 'core.hooksPath', '.custom-hooks']);

		const result = run(root, 'bun', ['scripts/install-git-hooks.ts']);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('core.hooksPath');
		expect(() => readFileSync(hookFile(root))).toThrow();
	});
});

describe('format-staged file set', () => {
	it('matches the CI format gate in scripts/check-format.sh', () => {
		const gate = readFileSync(join(REPOSITORY_ROOT, 'scripts/check-format.sh'), 'utf8');
		const block = /^pathspecs=\(\n([\s\S]*?)\n\)/m.exec(gate)?.[1];
		expect(block).toBeDefined();
		const gateSpecs = [...block!.matchAll(/'([^']+)'/g)].map((match) => match[1]);
		expect(gateSpecs).toEqual([...FORMAT_PATHSPECS]);
	});
});
