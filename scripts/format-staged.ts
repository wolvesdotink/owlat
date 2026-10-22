/**
 * Pre-commit formatter: runs oxfmt over the staged JS/TS files and stages the
 * result. Installed as the pre-commit hook by `bun run hooks:install`
 * (scripts/install-git-hooks.ts); `bun run format:staged` runs it by hand.
 *
 *   - Only the staged content is formatted. Each staged blob goes through
 *     `oxfmt --stdin-filepath`, so unstaged edits never reach the commit.
 *   - The working-tree file is rewritten only when it still equals the staged
 *     blob. A partially staged file keeps its unstaged bytes exactly as they
 *     were; only its staged version is formatted.
 *   - Every file is formatted before anything is written. If oxfmt rejects one
 *     (a syntax error), the index and the working tree stay untouched and the
 *     commit is refused.
 *   - The file set matches the CI format gate (scripts/check-format.sh): the six
 *     JS/TS extensions, minus Convex `_generated/` output. A test keeps the two
 *     lists equal.
 *   - A merge commit is left alone: its staged set holds the other branch's
 *     changes, and reformatting those would hide edits inside the merge.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, join } from 'node:path';

export const FORMAT_PATHSPECS = [
	'*.ts',
	'*.tsx',
	'*.js',
	'*.jsx',
	'*.mjs',
	'*.cjs',
	':(exclude)**/_generated/**',
] as const;

// Regular files only: a symlink's blob is its target path, and a submodule
// entry has no blob in this repository.
const REGULAR_FILE_MODES = new Set(['100644', '100755']);

interface StagedFile {
	path: string;
	mode: string;
	blob: string;
}

interface FormattedFile extends StagedFile {
	original: Buffer;
	formatted: Buffer;
}

function git(
	cwd: string,
	args: string[],
	input?: Buffer | string,
	env: NodeJS.ProcessEnv = process.env
): Buffer {
	const result = spawnSync('git', args, { cwd, input, env, maxBuffer: 1024 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
	}
	return result.stdout;
}

function gitText(cwd: string, args: string[]): string {
	return git(cwd, args).toString('utf8').trim();
}

function refExists(cwd: string, ref: string): boolean {
	return spawnSync('git', ['rev-parse', '--quiet', '--verify', ref], { cwd }).status === 0;
}

/** Staged additions and modifications of formatter-owned files, from `git diff --raw -z`. */
function stagedFiles(root: string): StagedFile[] {
	// The first commit has no HEAD to diff against; compare with the empty tree.
	const base = refExists(root, 'HEAD')
		? 'HEAD'
		: git(root, ['hash-object', '-t', 'tree', '--stdin'], '').toString('utf8').trim();
	const raw = git(root, [
		'diff',
		'--cached',
		'--raw',
		'-z',
		'--no-renames',
		'--no-abbrev',
		'--diff-filter=AMT',
		base,
		'--',
		...FORMAT_PATHSPECS,
	]).toString('utf8');
	const fields = raw.split('\0');
	const files: StagedFile[] = [];
	for (let i = 0; i + 1 < fields.length; i += 2) {
		// `:<old mode> <new mode> <old blob> <new blob> <status>`, then the path.
		const [, mode, , blob] = fields[i]!.slice(1).split(' ');
		const path = fields[i + 1]!;
		if (mode && blob && REGULAR_FILE_MODES.has(mode)) files.push({ path, mode, blob });
	}
	return files;
}

function oxfmtBinary(root: string): string | undefined {
	for (const name of ['oxfmt', 'oxfmt.exe']) {
		const candidate = join(root, 'node_modules', '.bin', name);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function formatBlob(
	root: string,
	oxfmt: string,
	file: StagedFile,
	original: Buffer
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		// Run from the repository root with the real path, so oxfmt resolves the
		// parser and any nested config exactly as the CI gate does for that file.
		const child = spawn(oxfmt, ['--config', 'oxfmtrc.json', `--stdin-filepath=${file.path}`], {
			cwd: root,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) return resolve(Buffer.concat(stdout));
			const message = Buffer.concat([...stderr, ...stdout])
				.toString('utf8')
				.trim();
			reject(new Error(message || `oxfmt exited with code ${code}`));
		});
		child.stdin.end(original);
	});
}

async function formatAll(
	root: string,
	oxfmt: string,
	files: StagedFile[]
): Promise<{ formatted: FormattedFile[]; failures: string[] }> {
	const formatted: FormattedFile[] = [];
	const failures: string[] = [];
	let next = 0;
	const worker = async () => {
		while (next < files.length) {
			const file = files[next++]!;
			const original = git(root, ['cat-file', 'blob', file.blob]);
			try {
				formatted.push({
					...file,
					original,
					formatted: await formatBlob(root, oxfmt, file, original),
				});
			} catch (error) {
				failures.push(`${file.path}: ${(error as Error).message}`);
			}
		}
	};
	const workers = Math.max(1, Math.min(8, availableParallelism(), files.length));
	await Promise.all(Array.from({ length: workers }, worker));
	return { formatted, failures };
}

/**
 * `git commit <paths>` builds the commit from a temporary `next-index-*.lock`
 * (the hook's GIT_INDEX_FILE) and, in parallel, holds the real index as
 * `index.lock` with the same paths added; git renames that lock into place
 * after the commit. Formatting only the temporary index would leave the real
 * index staging the unformatted content back over the new commit, so the
 * locked real index gets the same update.
 */
function pathCommitIndex(root: string): string | undefined {
	const hookIndex = process.env['GIT_INDEX_FILE'];
	if (!hookIndex || !basename(hookIndex).startsWith('next-index-')) return undefined;
	const lock = join(gitText(root, ['rev-parse', '--absolute-git-dir']), 'index.lock');
	return existsSync(lock) ? lock : undefined;
}

/** Rewrites the working-tree file only when it holds exactly the staged bytes. */
function worktreeMatchesStaged(root: string, file: FormattedFile): boolean {
	const absolute = join(root, file.path);
	try {
		if (!lstatSync(absolute).isFile()) return false;
		return readFileSync(absolute).equals(file.original);
	} catch {
		return false;
	}
}

async function formatStaged(root: string): Promise<number> {
	if (refExists(root, 'MERGE_HEAD')) {
		console.info('format-staged: merge in progress; leaving the staged files as they are.');
		return 0;
	}
	const oxfmt = oxfmtBinary(root);
	if (!oxfmt) {
		console.error('format-staged: oxfmt is not installed (run `bun install`); skipping.');
		return 0;
	}
	const files = stagedFiles(root);
	if (files.length === 0) return 0;

	const { formatted, failures } = await formatAll(root, oxfmt, files);
	if (failures.length > 0) {
		console.error('format-staged: oxfmt could not format these staged files:');
		for (const failure of failures.sort()) console.error(`  ${failure}`);
		console.error('Nothing was changed. Fix them, or commit with --no-verify to skip formatting.');
		return 1;
	}

	const changed = formatted
		.filter((file) => !file.formatted.equals(file.original))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	if (changed.length === 0) return 0;

	// Decide which working-tree files to rewrite before the index changes.
	const rewriteWorktree = changed.filter((file) => worktreeMatchesStaged(root, file));

	// One index update for every file. `--index-info -z` takes NUL-terminated
	// `<mode> <blob>\t<path>` records, so any path survives unquoted.
	const records = changed.map((file) => {
		const blob = git(root, ['hash-object', '-w', '--stdin'], file.formatted)
			.toString('utf8')
			.trim();
		return `${file.mode} ${blob}\t${file.path}\0`;
	});
	git(root, ['update-index', '-z', '--index-info'], records.join(''));
	const realIndex = pathCommitIndex(root);
	if (realIndex) {
		git(root, ['update-index', '-z', '--index-info'], records.join(''), {
			...process.env,
			GIT_INDEX_FILE: realIndex,
		});
	}

	for (const file of rewriteWorktree) writeFileSync(join(root, file.path), file.formatted);

	console.info(`format-staged: formatted ${changed.length} staged file(s):`);
	for (const file of changed) console.info(`  ${file.path}`);
	return 0;
}

if (import.meta.main) {
	const root = gitText(process.cwd(), ['rev-parse', '--show-toplevel']);
	process.exit(await formatStaged(root));
}
