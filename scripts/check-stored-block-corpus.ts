/**
 * History gate for the stored EditorBlock corpus
 * (packages/email-renderer/src/__tests__/storedBlocks; the rules are in its
 * corpus.ts). The corpus tests check what is there. Only the diff against the
 * base branch shows how it got there, and `vitest -u` would otherwise rewrite
 * a snapshot without anyone bumping the renderer version:
 *
 * - a fixture or snapshot that exists on the base is never modified. A fixture
 *   records what a writer stored; a snapshot of a renderer version changes only
 *   by moving to a new EMAIL_RENDERER_VERSION directory;
 * - a fixture `v<N>/<name>.json` is deleted only when `retired.json` retires
 *   contentBlockVersion N;
 * - a snapshot `renderer-v<N>/<name>.html` is deleted only together with its
 *   fixture, or once EMAIL_RENDERER_VERSION is no longer N.
 *
 * What it compares with:
 * - a pull request (GITHUB_BASE_REF): the merge base with its target branch;
 * - a CI push: the commit the branch pointed at before the push
 *   (STORED_BLOCK_CORPUS_PUSH_BEFORE, set from `github.event.before` by the Lint
 *   job in .github/workflows/test.yml), or HEAD's parent when that is missing
 *   or all zeros (a new branch or tag), or the empty tree for a root commit;
 * - STORED_BLOCK_CORPUS_BASE when set, otherwise origin/main locally.
 * The diff runs from that commit to the working tree, so uncommitted edits
 * count. History a shallow checkout lacks is fetched; if the base still cannot
 * be resolved the gate fails in CI (CI=true) and only warns locally, so a
 * missing base never passes a rewrite unseen.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CORPUS = 'packages/email-renderer/src/__tests__/storedBlocks';
const VERSION_FILE = 'packages/email-renderer/src/version.ts';
/** `git hash-object -t tree /dev/null`: the base of a root commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const root = join(import.meta.dirname, '..');
const env = process.env;

function git(args: string[]): { ok: boolean; out: string } {
	const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
	return { ok: result.status === 0, out: result.stdout.trim() };
}

const commitOf = (ref: string): string | undefined => {
	const result = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
	return result.ok ? result.out : undefined;
};

/** Best effort: fill in the history a shallow checkout left out. */
function deepen(): void {
	if (git(['rev-parse', '--is-shallow-repository']).out === 'true') {
		git(['fetch', '--quiet', '--unshallow', 'origin']);
	}
}

/** The merge base of `ref` and HEAD, fetching history once if it is missing. */
function mergeBaseWith(ref: string): string | undefined {
	for (const attempt of [0, 1]) {
		if (attempt === 1) deepen();
		const result = git(['merge-base', ref, 'HEAD']);
		if (result.ok) return result.out;
	}
	return undefined;
}

/** HEAD's parent; the empty tree for a root commit; undefined if history is cut. */
function parentOfHead(): string | undefined {
	deepen();
	const parent = commitOf('HEAD~1');
	if (parent) return parent;
	const shallow = git(['rev-parse', '--is-shallow-repository']).out === 'true';
	return shallow ? undefined : EMPTY_TREE;
}

function pushBase(): { label: string; commit: string | undefined } {
	const before = env['STORED_BLOCK_CORPUS_PUSH_BEFORE'] ?? '';
	if (before === '' || /^0+$/.test(before)) {
		return { label: 'HEAD~1', commit: parentOfHead() };
	}
	if (!commitOf(before)) git(['fetch', '--quiet', 'origin', before]);
	if (!commitOf(before)) deepen();
	return { label: before, commit: commitOf(before) ? mergeBaseWith(before) : undefined };
}

function resolveBase(): { label: string; commit: string | undefined } {
	const explicit = env['STORED_BLOCK_CORPUS_BASE'];
	if (explicit) return { label: explicit, commit: mergeBaseWith(explicit) };
	const target = env['GITHUB_BASE_REF'];
	if (target) {
		git(['fetch', '--quiet', 'origin', target]);
		const ref = `origin/${target}`;
		return { label: ref, commit: commitOf(ref) ? mergeBaseWith(ref) : undefined };
	}
	if (env['GITHUB_ACTIONS'] === 'true') return pushBase();
	return {
		label: 'origin/main',
		commit: commitOf('origin/main') ? mergeBaseWith('origin/main') : undefined,
	};
}

const { label: base, commit: baseCommit } = resolveBase();
if (!baseCommit) {
	const message = `check-stored-block-corpus: cannot resolve the base ${base} to compare the corpus with`;
	if (env['CI'] === 'true') {
		console.error(
			`${message}; fetch the history (fetch-depth: 0) or set STORED_BLOCK_CORPUS_BASE.`
		);
		process.exit(1);
	}
	process.stderr.write(`${message}; skipping outside CI.\n`);
	process.exit(0);
}

const changes = git(['diff', '--no-renames', '--name-status', baseCommit, '--', CORPUS])
	.out.split('\n')
	.filter(Boolean)
	.map((line) => {
		const [status = '', path = ''] = line.split('\t');
		return { status, path: path.slice(CORPUS.length + 1) };
	});

const retiredPath = join(root, CORPUS, 'retired.json');
const retired = existsSync(retiredPath)
	? (JSON.parse(readFileSync(retiredPath, 'utf8')) as Record<string, string>)
	: {};
const rendererVersion = /EMAIL_RENDERER_VERSION\s*=\s*(\d+)/.exec(
	readFileSync(join(root, VERSION_FILE), 'utf8')
)?.[1];

const deletedFixtures = new Set(
	changes
		.filter((change) => change.status === 'D' && /^v\d+\/[^/]+\.json$/.test(change.path))
		.map((change) => change.path.replace(/^v\d+\/(.+)\.json$/, '$1'))
);

const violations: string[] = [];
for (const { status, path } of changes) {
	const fixture = /^v(\d+)\/[^/]+\.json$/.exec(path);
	const snapshot = /^snapshots\/renderer-v(\d+)\/([^/]+)\.html$/.exec(path);
	if (!fixture && !snapshot) continue;
	if (status === 'M') {
		violations.push(
			fixture
				? `${path}: a stored fixture is a record; add a new fixture instead of editing it`
				: `${path}: snapshots of a renderer version are never rewritten; bump EMAIL_RENDERER_VERSION and write a new snapshot directory`
		);
	} else if (status === 'D' && fixture && retired[fixture[1]!] === undefined) {
		violations.push(
			`${path}: a fixture goes only when retired.json retires contentBlockVersion ${fixture[1]} with its migration`
		);
	} else if (
		status === 'D' &&
		snapshot &&
		snapshot[1] === rendererVersion &&
		!deletedFixtures.has(snapshot[2]!)
	) {
		violations.push(
			`${path}: a snapshot of the current renderer version goes only with its fixture or a version bump`
		);
	}
}

if (violations.length > 0) {
	console.error(`check-stored-block-corpus: ${violations.length} violation(s) against ${base}:`);
	console.error(violations.join('\n'));
	process.exit(1);
}
process.stdout.write(
	`check-stored-block-corpus: ${changes.length} corpus change(s) against ${base}, ok.\n`
);
