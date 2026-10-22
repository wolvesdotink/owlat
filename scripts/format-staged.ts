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
 *   - Content reaches a child process's stdin from a file descriptor, never a
 *     pipe written by this process: a pipe payload that gets lost arrives as
 *     empty input, and an empty formatter result or an empty blob staged in
 *     its place would erase the file from the commit. The results are checked
 *     too: empty oxfmt output for non-blank input, a blob id that does not hash
 *     the formatted bytes, or an index entry that did not take all refuse the
 *     commit.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
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

interface StagedBlob extends FormattedFile {
	formattedBlob: string;
}

let scratchDirectory: string | undefined;
let scratchFiles = 0;

/** A read-only descriptor over a scratch file holding `input`, for a child's stdin. */
function inputDescriptor(input: Buffer | string): number {
	scratchDirectory ??= mkdtempSync(join(tmpdir(), 'owlat-format-staged-'));
	const path = join(scratchDirectory, String(scratchFiles++));
	writeFileSync(path, input);
	return openSync(path, 'r');
}

function removeScratch(): void {
	if (scratchDirectory) rmSync(scratchDirectory, { recursive: true, force: true });
	scratchDirectory = undefined;
}

function git(
	cwd: string,
	args: string[],
	input?: Buffer | string,
	env: NodeJS.ProcessEnv = process.env
): Buffer {
	const stdin = input === undefined ? 'ignore' : inputDescriptor(input);
	try {
		const result = spawnSync('git', args, {
			cwd,
			env,
			stdio: [stdin, 'pipe', 'pipe'],
			maxBuffer: 1024 * 1024 * 1024,
		});
		if (result.error) throw result.error;
		if (result.status !== 0) {
			throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
		}
		return result.stdout;
	} finally {
		if (typeof stdin === 'number') closeSync(stdin);
	}
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
	const stdin = inputDescriptor(original);
	const formatted = new Promise<Buffer>((resolve, reject) => {
		// Run from the repository root with the real path, so oxfmt resolves the
		// parser and any nested config exactly as the CI gate does for that file.
		const child = spawn(oxfmt, ['--config', 'oxfmtrc.json', `--stdin-filepath=${file.path}`], {
			cwd: root,
			stdio: [stdin, 'pipe', 'pipe'],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
		child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
		child.stdout!.on('error', reject);
		child.stderr!.on('error', reject);
		child.on('error', reject);
		child.on('close', (code) => {
			const output = Buffer.concat(stdout);
			if (code !== 0) {
				const message = Buffer.concat([...stderr, output])
					.toString('utf8')
					.trim();
				return reject(new Error(message || `oxfmt exited with code ${code}`));
			}
			// Formatting never empties a file that holds code; empty output means
			// the input never arrived, and staging it would delete the file's content.
			if (output.length === 0 && original.toString('utf8').trim() !== '') {
				return reject(new Error('oxfmt returned no output for a non-empty file'));
			}
			resolve(output);
		});
	});
	return formatted.finally(() => closeSync(stdin));
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

/** The object id git assigns to a blob with these bytes, in the repository's hash. */
function blobId(objectFormat: string, contents: Buffer): string {
	return createHash(objectFormat)
		.update(`blob ${contents.length}\0`)
		.update(contents)
		.digest('hex');
}

/** Index entries (`<mode> <blob>`) for the given paths, keyed by path. */
function indexEntries(root: string, paths: string[], env: NodeJS.ProcessEnv): Map<string, string> {
	const raw = git(
		root,
		['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...paths],
		undefined,
		env
	);
	const entries = new Map<string, string>();
	for (const record of raw.toString('utf8').split('\0')) {
		const tab = record.indexOf('\t');
		if (tab < 0) continue;
		const [mode, blob] = record.slice(0, tab).split(' ');
		entries.set(record.slice(tab + 1), `${mode} ${blob}`);
	}
	return entries;
}

/** Stages the formatted blobs in one index, then confirms every entry took. */
function updateIndex(root: string, changed: StagedBlob[], env: NodeJS.ProcessEnv): void {
	// `--index-info -z` takes NUL-terminated `<mode> <blob>\t<path>` records, so
	// any path survives unquoted.
	const records = changed.map((file) => `${file.mode} ${file.formattedBlob}\t${file.path}\0`);
	git(root, ['update-index', '-z', '--index-info'], records.join(''), env);
	const entries = indexEntries(
		root,
		changed.map((file) => file.path),
		env
	);
	const missing = changed.filter(
		(file) => entries.get(file.path) !== `${file.mode} ${file.formattedBlob}`
	);
	if (missing.length > 0) {
		throw new Error(
			`the index did not take the formatted version of ${missing.map((file) => file.path).join(', ')}`
		);
	}
}

/** The working-tree file still holds exactly the staged (unformatted) bytes. */
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

	const objectFormat = gitText(root, ['rev-parse', '--show-object-format']);
	const blobs: StagedBlob[] = changed.map((file) => {
		const formattedBlob = git(root, ['hash-object', '-w', '--stdin'], file.formatted)
			.toString('utf8')
			.trim();
		if (formattedBlob !== blobId(objectFormat, file.formatted)) {
			throw new Error(`git stored different bytes than oxfmt produced for ${file.path}`);
		}
		return { ...file, formattedBlob };
	});
	updateIndex(root, blobs, process.env);
	const realIndex = pathCommitIndex(root);
	if (realIndex) updateIndex(root, blobs, { ...process.env, GIT_INDEX_FILE: realIndex });

	// Each file is compared right before it is rewritten, so an edit saved while
	// the index was being updated is kept rather than overwritten.
	const keptEdits: string[] = [];
	for (const file of blobs) {
		if (worktreeMatchesStaged(root, file)) writeFileSync(join(root, file.path), file.formatted);
		else keptEdits.push(file.path);
	}

	console.info(`format-staged: formatted ${changed.length} staged file(s):`);
	for (const file of changed) console.info(`  ${file.path}`);
	if (keptEdits.length > 0) {
		console.info('Unstaged edits kept; these working-tree files were not reformatted:');
		for (const path of keptEdits) console.info(`  ${path}`);
	}
	return 0;
}

async function main(): Promise<number> {
	try {
		const root = gitText(process.cwd(), ['rev-parse', '--show-toplevel']);
		return await formatStaged(root);
	} catch (error) {
		console.error(`format-staged: ${(error as Error).message}`);
		console.error('The commit was refused. Check `git diff --cached` before committing again.');
		return 1;
	} finally {
		removeScratch();
	}
}

if (import.meta.main) {
	process.exit(await main());
}
