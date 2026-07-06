/**
 * Cut a release in one command: bump every version in the repo, generate the
 * CHANGELOG.md section from conventional commits, commit, and create the
 * annotated `vX.Y.Z` tag. Pushing the tag triggers the unified release
 * pipeline (.github/workflows/release.yml), which builds the server images and
 * desktop apps and publishes the GitHub Release.
 *
 *   bun run release:cut <version|major|minor|patch> [flags]
 *
 *   bun run release:cut 0.2.0            # bump to 0.2.0, commit + tag
 *   bun run release:cut minor --push     # bump, commit, tag, push main + tag
 *   bun run release:cut patch --dry-run  # show what would change
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
 *     version from Cargo.toml — the desktop build breaks off the tag if stale)
 *   - any source line carrying an `x-release-version` marker comment
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
const positional = rawArgs.filter((a) => !a.startsWith('--'));
const dryRun = flags.has('--dry-run');
const noCommit = flags.has('--no-commit');
const push = flags.has('--push');
const anyBranch = flags.has('--any-branch');

const known = new Set(['--dry-run', '--no-commit', '--push', '--any-branch']);
for (const flag of flags) {
	if (!known.has(flag)) fail(`unknown flag ${flag}`);
}
const request = positional[0];
if (!request)
	fail(
		'usage: bun run release:cut <version|major|minor|patch> [--dry-run] [--no-commit] [--push] [--any-branch]'
	);

const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
	version: string;
};
const oldVersion = rootPkg.version;

function bump(current: string, kind: string): string {
	const [major = 0, minor = 0, patch = 0] = current.split('-')[0]?.split('.').map(Number) ?? [];
	if (kind === 'major') return `${major + 1}.0.0`;
	if (kind === 'minor') return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

const newVersion = ['major', 'minor', 'patch'].includes(request)
	? bump(oldVersion, request)
	: request.replace(/^v/, '');
if (!new RegExp(`^${SEMVER_RE.source}$`).test(newVersion)) {
	fail(`"${newVersion}" is not a valid semver version`);
}
if (newVersion === oldVersion) fail(`already at ${oldVersion}`);
const tag = `v${newVersion}`;

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
if (git('tag', '-l', tag) !== '') fail(`tag ${tag} already exists`);

console.info(`Releasing ${oldVersion} → ${newVersion} (tag ${tag})`);

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

const cargoToml = 'apps/desktop/src-tauri/Cargo.toml';
changes.push({
	file: cargoToml,
	apply: (c) => c.replace(/^version = "[^"]+"$/m, `version = "${newVersion}"`),
});

const cargoLock = 'apps/desktop/src-tauri/Cargo.lock';
changes.push({
	file: cargoLock,
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
					line.includes(MARKER) ? line.replace(new RegExp(SEMVER_RE.source, 'g'), newVersion) : line
				)
				.join('\n'),
	});
}

// --- changelog ---------------------------------------------------------------

let lastTag = '';
try {
	lastTag = git('describe', '--tags', '--match', 'v[0-9]*', '--abbrev=0');
} catch {
	console.info('No previous v* tag reachable — changelog covers the full history.');
}
const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
const subjects = git('log', '--format=%s', '--no-merges', range).split('\n').filter(Boolean);

const buckets: Record<string, string[]> = {
	Added: [],
	Changed: [],
	Fixed: [],
	Removed: [],
	Security: [],
	Documentation: [],
};
const typeToBucket: Record<string, string> = {
	feat: 'Added',
	fix: 'Fixed',
	perf: 'Changed',
	refactor: 'Changed',
	style: 'Changed',
	revert: 'Removed',
	docs: 'Documentation',
	security: 'Security',
};
const seen = new Set<string>();
for (const subject of subjects) {
	const match = subject.match(/^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/);
	if (!match) continue;
	const bucket = typeToBucket[match[1] ?? ''];
	if (!bucket) continue; // chore / test / ci / build stay out of the changelog
	const scope = match[2];
	const entry = `- ${scope ? `**${scope}**: ` : ''}${match[3]}`;
	if (seen.has(entry)) continue;
	seen.add(entry);
	buckets[bucket]?.push(entry);
}

const today = new Date().toISOString().slice(0, 10);
const changelogPath = 'CHANGELOG.md';
const changelog = readFileSync(join(ROOT, changelogPath), 'utf8');

// Fold whatever was hand-curated under [Unreleased] into the new section.
const unreleasedRe = /## \[Unreleased\]\n([\s\S]*?)(?=\n## |\n<!-- Add released versions)/;
const unreleasedMatch = changelog.match(unreleasedRe);
const curated = unreleasedMatch?.[1]?.trim() ?? '';

let section = `## [${newVersion}] - ${today}\n`;
if (curated) section += `\n${curated}\n`;
for (const [bucket, entries] of Object.entries(buckets)) {
	if (entries.length === 0) continue;
	section += `\n### ${bucket}\n${entries.join('\n')}\n`;
}

const releaseMarker = '<!-- Add released versions below this line, newest first. -->';
if (!changelog.includes(releaseMarker))
	fail(`CHANGELOG.md is missing the "${releaseMarker}" marker`);
changes.push({
	file: changelogPath,
	apply: (c) =>
		c
			.replace(unreleasedRe, '## [Unreleased]\n')
			.replace(releaseMarker, `${releaseMarker}\n\n${section.trimEnd()}`),
});

// --- apply -------------------------------------------------------------------

const changed: string[] = [];
for (const { file, apply } of changes) {
	const before = readFileSync(join(ROOT, file), 'utf8');
	const after = apply(before);
	if (after === before) fail(`${file}: nothing to replace — pattern drifted?`);
	changed.push(file);
	if (!dryRun) writeFileSync(join(ROOT, file), after);
}

console.info(`${dryRun ? '[dry-run] Would update' : 'Updated'} ${changed.length} files:`);
for (const file of changed) console.info(`  ${file}`);
const bucketSummary = Object.entries(buckets)
	.filter(([, entries]) => entries.length > 0)
	.map(([bucket, entries]) => `${entries.length} ${bucket.toLowerCase()}`)
	.join(', ');
console.info(
	`Changelog (${lastTag || 'full history'}): ${bucketSummary || 'no conventional commits found'}`
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
	console.info(`Pushed main and ${tag} — the release pipeline is now building:`);
	console.info(`  https://github.com/wolvesdotink/owlat/actions/workflows/release.yml`);
} else {
	console.info(`To trigger the release pipeline:`);
	console.info(`  git push origin HEAD:main && git push origin ${tag}`);
}
