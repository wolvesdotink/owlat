/**
 * Installs (or removes) the pre-commit hook that formats staged files with
 * oxfmt (scripts/format-staged.ts).
 *
 *   bun run hooks:install      write .git/hooks/pre-commit
 *   bun run hooks:uninstall    remove it again
 *
 * Git keeps hooks in the common git directory, so one install covers every
 * linked worktree of the clone. The installed hook therefore holds no paths:
 * git runs it from the root of whichever worktree is committing, and it calls
 * that worktree's own scripts/format-staged.ts, or does nothing on a branch
 * that predates it.
 *
 * Installation is opt-in rather than a `prepare` script: Docker images run
 * `bun install` without scripts/ or a git directory, and a clone's hooks are
 * shared by every session working in its worktrees.
 *
 * A pre-commit hook this script did not write is never replaced, and a clone
 * with `core.hooksPath` set (a hook manager, or a global hooks directory shared
 * with other repositories) is left alone; both cases print how to call the
 * formatter from the existing hook instead.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HOOK_MARKER = '# owlat-managed pre-commit hook';

const HOOK_SCRIPT = `#!/bin/sh
${HOOK_MARKER} (scripts/install-git-hooks.ts); remove with: bun run hooks:uninstall
# Git runs this from the root of the committing worktree. Hooks are shared by
# every worktree of the clone, and a branch that predates the formatter has no
# script to run.
[ -f scripts/format-staged.ts ] || exit 0
if ! command -v bun >/dev/null 2>&1; then
	echo "pre-commit: bun is not on PATH; staged files were not formatted." >&2
	exit 0
fi
exec bun scripts/format-staged.ts
`;

const MANUAL_HOOK_LINE = 'bun scripts/format-staged.ts';

function git(args: string[]): { status: number | null; stdout: string } {
	const result = spawnSync('git', args, { encoding: 'utf8' });
	if (result.error) throw result.error;
	return { status: result.status, stdout: result.stdout.trim() };
}

function hookPath(): string {
	const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
	if (common.status !== 0 || !common.stdout) throw new Error('not inside a git repository');
	return join(common.stdout, 'hooks', 'pre-commit');
}

function isOwlatHook(path: string): boolean {
	return readFileSync(path, 'utf8').includes(HOOK_MARKER);
}

function install(): number {
	const hooksPath = git(['config', '--get', 'core.hooksPath']).stdout;
	if (hooksPath) {
		console.error(`hooks:install: core.hooksPath is set (${hooksPath}); not installing.`);
		console.error(`Call \`${MANUAL_HOOK_LINE}\` from that pre-commit hook instead.`);
		return 1;
	}
	const path = hookPath();
	if (existsSync(path) && !isOwlatHook(path)) {
		console.error(`hooks:install: ${path} already exists and was not written by Owlat.`);
		console.error(`Add \`${MANUAL_HOOK_LINE}\` to it, or remove it and run this again.`);
		return 1;
	}
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, HOOK_SCRIPT);
	chmodSync(path, 0o755);
	console.info(`hooks:install: pre-commit hook installed at ${path}`);
	return 0;
}

function uninstall(): number {
	const path = hookPath();
	if (!existsSync(path)) {
		console.info('hooks:uninstall: no pre-commit hook installed.');
		return 0;
	}
	if (!isOwlatHook(path)) {
		console.error(`hooks:uninstall: ${path} was not written by Owlat; leaving it.`);
		return 1;
	}
	rmSync(path);
	console.info(`hooks:uninstall: removed ${path}`);
	return 0;
}

if (import.meta.main) {
	process.exit(process.argv.includes('--uninstall') ? uninstall() : install());
}
