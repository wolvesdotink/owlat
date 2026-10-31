/**
 * Cut a release candidate in one command: bump every version in the repo to
 * the version being prepared, write its CHANGELOG.md section from
 * conventional commits, commit, and create the annotated `vX.Y.Z-rc.N` tag.
 * Pushing the tag runs the whole unified release pipeline
 * (.github/workflows/release.yml) and publishes a prerelease that neither the
 * installer, the updaters nor the image aliases pick up.
 *
 *   bun run release:cut <version|major|minor|patch|rc> [flags]
 *
 *   bun run release:cut minor --push     # 0.6.16 → prepare 0.7.0, tag v0.7.0-rc.1
 *   bun run release:cut rc --push        # next candidate of the prepared 0.7.0
 *   bun run release:cut patch --dry-run  # show what would change
 *
 * The stable release is the candidate's own commit, tagged by
 * `bun run release:promote vX.Y.Z-rc.N` (scripts/release-promote.ts) once that
 * candidate's release run is green. So the commit a candidate is cut from
 * already holds the stable version, its notes and its schema snapshot; the
 * pipeline stamps `X.Y.Z-rc.N` into the candidate's artifacts from the tag.
 *
 * A later candidate of the same version (`rc`, or the prepared version again)
 * keeps the versions, extends the version's CHANGELOG section with what landed
 * since the previous candidate, and moves the schema snapshot to HEAD.
 *
 * Flags:
 *   --dry-run     print planned changes without touching anything
 *   --no-commit   write the file changes but skip commit + tag (curate first)
 *   --push        after tagging, push HEAD to origin/main and push the tag
 *   --any-branch  allow running from a branch other than main
 *
 * Version locations kept in sync (all must hold the same version):
 *   - every workspace package.json with a "version" field
 *   - apps/desktop/src-tauri/Cargo.toml + Cargo.lock (Tauri reads the app
 *     version from Cargo.toml; the release build re-stamps it from the tag)
 *   - any source line carrying an `x-release-version` marker comment
 *
 * The release commit also carries the schema-compat snapshot of the release's
 * own schema and callable functions
 * (apps/api/convex/__tests__/schemaCompat/previousRelease.json), so every later
 * PR is checked against the rows this release can store and the calls its
 * clients and workers can make.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { candidatesOf, classifyReleaseTag, nextCandidateTag } from './ci/release-policy';
import { readPackageManifest, requiredVersion } from './package-manifest';
import { bucketSubjects, bucketSummary, writeSection } from './release-changelog';

const ROOT = join(import.meta.dir, '..');
const SEMVER_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
const MARKER = 'x-release-version';

function git(...args: string[]): string {
	return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function fail(message: string): never {
	console.error(`\nrelease: ${message}`);
	process.exit(1);
}

// --- argument parsing -------------------------------------------------------

const rawArgs = process.argv.slice(2);
const flags = new Set(rawArgs.filter((a) => a.startsWith('--')));
const dryRun = flags.has('--dry-run');
const noCommit = flags.has('--no-commit');
const push = flags.has('--push');
const anyBranch = flags.has('--any-branch');

const known = new Set(['--dry-run', '--no-commit', '--push', '--any-branch']);
for (const flag of flags) {
	if (!known.has(flag)) fail(`unknown flag ${flag}`);
}
const request = rawArgs.find((a) => !a.startsWith('--'));
if (!request)
	fail(
		'usage: bun run release:cut <version|major|minor|patch|rc> [--dry-run] [--no-commit] [--push] [--any-branch]'
	);

const oldVersion = requiredVersion(readPackageManifest(join(ROOT, 'package.json')), 'package.json');

function bump(current: string, kind: string): string {
	const [major = 0, minor = 0, patch = 0] = current.split('-')[0]?.split('.').map(Number) ?? [];
	if (kind === 'major') return `${major + 1}.0.0`;
	if (kind === 'minor') return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

// --- preflight ---------------------------------------------------------------

if (git('status', '--porcelain') !== '') fail('working tree is not clean');
const branch = git('branch', '--show-current');
if (branch !== 'main' && !anyBranch) {
	fail(`on branch "${branch}" — releases cut from main (or pass --any-branch)`);
}
git('fetch', 'origin', 'main', '--tags');
try {
	git('merge-base', '--is-ancestor', 'origin/main', 'HEAD');
} catch {
	fail('HEAD is behind origin/main — rebase first');
}

const tags = git('tag', '--list', 'v*').split('\n').filter(Boolean);
const released = (version: string) => tags.includes(`v${version}`);

// The version being prepared, and the candidate tag this cut creates.
let newVersion: string;
let tag: string;
if (request === 'rc') {
	newVersion = oldVersion;
	if (released(newVersion))
		fail(
			`${newVersion} is already released — name the next version (patch, minor, major or X.Y.Z)`
		);
	tag = nextCandidateTag(newVersion, tags);
} else if (['major', 'minor', 'patch'].includes(request)) {
	newVersion = bump(oldVersion, request);
	tag = nextCandidateTag(newVersion, tags);
} else {
	const parsed = classifyReleaseTag(`v${request.replace(/^v/, '')}`);
	if (!parsed || parsed.channel === 'prerelease')
		fail(`"${request}" is neither X.Y.Z nor a release candidate X.Y.Z-rc.N`);
	newVersion = parsed.base;
	tag = nextCandidateTag(newVersion, tags);
	if (parsed.channel === 'rc' && parsed.tag !== tag)
		fail(`the next candidate is ${tag}, not ${parsed.tag}`);
}
if (!new RegExp(`^${SEMVER_RE.source}$`).test(newVersion)) {
	fail(`"${newVersion}" is not a valid semver version`);
}
if (released(newVersion)) fail(`v${newVersion} is already released`);
// Moving on from a version that never shipped would leave its section and
// candidates behind with nothing to promote them.
const preparing = newVersion !== oldVersion;
if (preparing && !released(oldVersion))
	fail(
		`${oldVersion} is prepared but not released: cut its next candidate (\`release:cut rc\`) or promote one (\`release:promote\`)`
	);
if (tags.includes(tag)) fail(`tag ${tag} already exists`);
const previousCandidate = candidatesOf(newVersion, tags)[0]?.tag;
if (
	previousCandidate &&
	git('rev-parse', 'HEAD') === git('rev-parse', `${previousCandidate}^{commit}`)
)
	fail(
		`HEAD is ${previousCandidate}'s commit — re-run its release instead of cutting another candidate`
	);

console.info(
	preparing
		? `Preparing ${oldVersion} → ${newVersion} (candidate ${tag})`
		: `Next candidate of ${newVersion}: ${tag}`
);

// --- collect version bumps ---------------------------------------------------

type Change = { file: string; apply: (content: string) => string };
const changes: Change[] = [];

function workspacePackageJsons(): string[] {
	const files = ['package.json'];
	for (const dir of ['apps', 'packages']) {
		for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const candidate = join(dir, entry.name, 'package.json');
			if (existsSync(join(ROOT, candidate))) files.push(candidate);
		}
	}
	return files;
}

if (preparing) {
	// Only rewrites the top-level "version" field (first occurrence); packages
	// without one (e.g. @owlat/marketing) are left untouched.
	const versionField = /^(\s*"version":\s*")([^"]+)(")/m;
	for (const file of workspacePackageJsons()) {
		const content = readFileSync(join(ROOT, file), 'utf8');
		const match = content.match(versionField);
		if (!match) continue;
		if (match[2] !== oldVersion) fail(`${file} holds ${match[2]}, expected ${oldVersion}`);
		changes.push({ file, apply: (c) => c.replace(versionField, `$1${newVersion}$3`) });
	}

	changes.push({
		file: 'apps/desktop/src-tauri/Cargo.toml',
		apply: (c) => c.replace(/^version = "[^"]+"$/m, `version = "${newVersion}"`),
	});
	changes.push({
		file: 'apps/desktop/src-tauri/Cargo.lock',
		apply: (c) => c.replace(/(name = "owlat-desktop"\nversion = ")[^"]+(")/, `$1${newVersion}$2`),
	});

	let markerFiles: string[] = [];
	try {
		markerFiles = git('grep', '-l', MARKER, '--', '*.ts', '*.rs', '*.vue', ':!scripts/release.ts')
			.split('\n')
			.filter(Boolean);
	} catch {
		// git grep exits non-zero when nothing matches — no marker lines to update.
	}
	for (const file of markerFiles) {
		changes.push({
			file,
			apply: (c) =>
				c
					.split('\n')
					.map((line) =>
						line.includes(MARKER)
							? line.replace(new RegExp(SEMVER_RE.source, 'g'), newVersion)
							: line
					)
					.join('\n'),
		});
	}
}

// --- changelog ---------------------------------------------------------------

// A first candidate covers everything since the last stable release; a later
// one only what landed since the previous candidate.
let since = previousCandidate ?? '';
if (!since) {
	try {
		since = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', '--exclude', 'v*-*');
	} catch {
		console.info('No previous stable tag reachable — changelog covers the full history.');
	}
} else {
	try {
		git('merge-base', '--is-ancestor', since, 'HEAD');
	} catch {
		fail(`${since} is not an ancestor of HEAD — cut candidates of one version from one line`);
	}
}
const range = since ? `${since}..HEAD` : 'HEAD';
const buckets = bucketSubjects(
	git('log', '--format=%s', '--no-merges', range).split('\n').filter(Boolean)
);
const today = new Date().toISOString().slice(0, 10);
const changelogPath = 'CHANGELOG.md';
let changelog: string;
try {
	changelog = writeSection(
		readFileSync(join(ROOT, changelogPath), 'utf8'),
		newVersion,
		today,
		buckets
	);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
changes.push({ file: changelogPath, apply: () => changelog });

// --- apply -------------------------------------------------------------------

// The version bump does not touch convex/, so HEAD's schema is the release's
// schema. The compat guard's snapshot moves forward in the release commit
// itself rather than in a follow-up commit someone has to remember. It runs
// before any file is rewritten, and writes the snapshot only on success. It
// is recorded as the stable tag, which is what later releases compare against.
const schemaSnapshot = 'apps/api/convex/__tests__/schemaCompat/previousRelease.json';
if (!dryRun) {
	try {
		execFileSync('bun', ['run', '--cwd', 'apps/api', 'schema-compat:refresh'], {
			cwd: ROOT,
			stdio: 'ignore',
			env: {
				...process.env,
				OWLAT_SCHEMA_COMPAT_REF: 'HEAD',
				OWLAT_SCHEMA_COMPAT_RELEASE: `v${newVersion}`,
			},
		});
	} catch {
		fail(
			'the schema-compat refresh failed — run `bun run --cwd apps/api schema-compat:refresh` to see why'
		);
	}
	if (git('status', '--porcelain', '--', schemaSnapshot) === '') {
		fail(`${schemaSnapshot} did not change — the schema-compat refresh wrote nothing`);
	}
}

const changed: string[] = dryRun ? [] : [schemaSnapshot];
for (const { file, apply } of changes) {
	const before = readFileSync(join(ROOT, file), 'utf8');
	const after = apply(before);
	if (after === before) {
		// A later candidate may bring nothing for the changelog (chore-only commits).
		if (file === changelogPath && !preparing) continue;
		fail(`${file}: nothing to replace — pattern drifted?`);
	}
	changed.push(file);
	if (!dryRun) writeFileSync(join(ROOT, file), after);
}

// bun.lock embeds each workspace's "version" field — refresh it so the
// lockfile stays in step with the bumped package.json files.
if (!dryRun && preparing) {
	execFileSync('bun', ['install'], { cwd: ROOT, stdio: 'ignore' });
	if (git('status', '--porcelain', '--', 'bun.lock') !== '') changed.push('bun.lock');
}

console.info(`${dryRun ? '[dry-run] Would update' : 'Updated'} ${changed.length} files:`);
for (const file of changed) console.info(`  ${file}`);
if (dryRun) console.info(`  ${schemaSnapshot} (schema-compat refresh from HEAD as v${newVersion})`);
console.info(
	`Changelog (${since || 'full history'}): ${bucketSummary(buckets) || 'no conventional commits found'}`
);

if (dryRun) process.exit(0);

if (noCommit) {
	console.info(`\nFiles written, nothing committed. Curate CHANGELOG.md, then:`);
	console.info(`  git add -A && git commit -m "chore(release): ${tag}"`);
	console.info(`  git tag -a ${tag} -m "Owlat ${tag}"`);
	console.info(`  git push origin HEAD:main && git push origin ${tag}`);
	process.exit(0);
}

git('add', '--', ...changed);
git('commit', '-m', `chore(release): ${tag}`);
git('tag', '-a', tag, '-m', `Owlat ${tag}`);
console.info(`\nCommitted and tagged ${tag}.`);

if (push) {
	git('push', 'origin', 'HEAD:main');
	git('push', 'origin', tag);
	console.info(`Pushed main and ${tag} — the release pipeline is now building the candidate:`);
	console.info(`  https://github.com/wolvesdotink/owlat/actions/workflows/release.yml`);
} else {
	console.info(`To trigger the release pipeline:`);
	console.info(`  git push origin HEAD:main && git push origin ${tag}`);
}
console.info(`Once its run is green, publish it as v${newVersion}:`);
console.info(`  bun run release:promote ${tag} --push`);
