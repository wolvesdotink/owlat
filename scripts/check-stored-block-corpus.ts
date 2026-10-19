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
 * The base is the pull request's target branch in CI, STORED_BLOCK_CORPUS_BASE
 * when set, otherwise origin/main. The diff runs from the merge base to the
 * working tree, so uncommitted edits count.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CORPUS = 'packages/email-renderer/src/__tests__/storedBlocks';
const VERSION_FILE = 'packages/email-renderer/src/version.ts';
const root = join(import.meta.dirname, '..');

function git(args: string[]): { ok: boolean; out: string } {
	const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
	return { ok: result.status === 0, out: result.stdout.trim() };
}

function baseRef(): string | undefined {
	const target = process.env['GITHUB_BASE_REF'];
	if (target) {
		git(['fetch', '--quiet', 'origin', target]);
		return `origin/${target}`;
	}
	const candidates = [process.env['STORED_BLOCK_CORPUS_BASE'], 'origin/main'];
	return candidates.find((ref) => ref && git(['rev-parse', '--verify', '--quiet', ref]).ok);
}

const base = baseRef();
const mergeBase = base ? git(['merge-base', base, 'HEAD']) : undefined;
if (!mergeBase?.ok) {
	console.log(`check-stored-block-corpus: no base to compare with (${base ?? 'none'}); skipping.`);
	process.exit(0);
}

const changes = git(['diff', '--no-renames', '--name-status', mergeBase.out, '--', CORPUS])
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
console.log(`check-stored-block-corpus: ${changes.length} corpus change(s) against ${base}, ok.`);
