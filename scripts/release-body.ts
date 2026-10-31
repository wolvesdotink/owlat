/**
 * Builds the GitHub Release body for a tag: what changed first, how to update
 * second.
 *
 *   bun scripts/release-body.ts <version> --repo <owner/name> > release-body.md
 *
 * The "what changed" half is the version's curated CHANGELOG.md section (the
 * prose lead-in, the **Upgrading.** note, then Added / Changed / Fixed). The
 * in-app update card renders that half and links to the docs for the rest, so
 * everything after the `## Updating` heading is for the GitHub page only.
 *
 * A release candidate (`X.Y.Z-rc.N`) uses the section of the version it is a
 * candidate for: it is cut from the commit the stable release will be tagged
 * on, so both carry the same notes. Its body opens with a note that nothing
 * updates to it on its own.
 *
 * A version without a CHANGELOG section fails: release.yml runs this before
 * anything is built, so a tag cut without `release:cut` stops there instead of
 * publishing a release with no notes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePublishedImages } from './ci/docker-images';
import { classifyReleaseTag } from './ci/release-policy';

export const UPDATE_DOCS_URL = 'https://docs.owlat.app/developer/self-hosting-maintenance#updating';

/** Published image names, in manifest order (docker/images.json is the one list). */
function imageNames(): string[] {
	const manifest = readFileSync(join(import.meta.dirname, '..', 'docker', 'images.json'), 'utf8');
	return parsePublishedImages(manifest, 'docker/images.json').map((image) => image.name);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The body of `## [<version>] - <date>`, without its heading; null when absent or empty. */
export function changelogSection(changelog: string, version: string): string | null {
	const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\][^\\n]*$`, 'm');
	const start = heading.exec(changelog);
	if (!start) return null;
	const rest = changelog.slice(start.index + start[0].length);
	const end = rest.search(/^## /m);
	const body = (end === -1 ? rest : rest.slice(0, end)).trim();
	return body || null;
}

/** The previous release in CHANGELOG.md order (newest first), for the compare link. */
export function previousVersion(changelog: string, version: string): string | null {
	const versions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+[^\]]*)\]/gm)].map((m) => m[1]);
	const i = versions.indexOf(version);
	return i === -1 ? null : (versions[i + 1] ?? null);
}

export function buildReleaseBody(opts: {
	version: string;
	changelog: string;
	repo: string;
	images?: string[];
}): string {
	const { version, changelog, repo, images = imageNames() } = opts;
	const release = classifyReleaseTag(`v${version}`);
	const candidate = release?.channel === 'rc' ? release.base : null;
	const notesVersion = changelogSection(changelog, version) || !candidate ? version : candidate;
	const section = changelogSection(changelog, notesVersion);
	if (!section) throw new Error(`CHANGELOG.md has no section for ${version}`);
	const owner = repo.split('/')[0];
	const tag = `v${version}`;
	const compose = `docker-compose-${version}.yml`;
	const download = `https://github.com/${repo}/releases/download/${tag}`;
	const previous = previousVersion(changelog, notesVersion);
	const lead = candidate
		? `> [!NOTE]\n> Release candidate for ${candidate}. Installs, the in-app update and desktop apps on the stable channel do not move to it on their own; install it explicitly to test it.\n\n`
		: '';

	return `${lead}${section}

## Updating

**Self-hosted server:** open **Settings → System & updates** and click **Update now**, or run \`owlat upgrade --version ${version}\`. The [update guide](${UPDATE_DOCS_URL}) covers both, the manual steps, and how to recover from a failed update.

**Desktop app:** existing installs update themselves. New installs: download the installer for your OS from the assets below (macOS \`.dmg\`, Windows \`.msi\`/\`.exe\`, Linux \`.AppImage\`/\`.deb\`).

### Manual upgrade

Fetch the compose file and its SHA256, verify, then apply:

\`\`\`sh
curl -fsSL ${download}/${compose} -o docker-compose.yml &&
curl -fsSL ${download}/${compose}.sha256 -o docker-compose.yml.sha256 &&
sha256sum -c <(sed "s|${compose}|docker-compose.yml|" docker-compose.yml.sha256) &&
docker compose pull &&
docker compose --profile deploy run --rm convex-deploy &&
docker compose up -d
\`\`\`

### Supply-chain verification (recommended)

\`\`\`sh
cosign verify ghcr.io/${owner}/web:${version} \\
  --certificate-identity-regexp "https://github.com/${repo}/.github/workflows/.*@.*" \\
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
gh attestation verify docker-compose.yml --repo ${repo}
\`\`\`

**Images:** ${images.map((i) => `\`${i}\``).join(', ')} — all \`ghcr.io/${owner}/<name>:${version}\`
${previous ? `\n**Full changelog:** https://github.com/${repo}/compare/v${previous}...${tag}\n` : ''}`;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const repoAt = args.indexOf('--repo');
	const repo = repoAt === -1 ? undefined : args[repoAt + 1];
	const version = args.find((a, i) => !a.startsWith('--') && i !== repoAt + 1)?.replace(/^v/, '');
	if (!version || !repo) {
		console.error('usage: bun scripts/release-body.ts <version> --repo <owner/name>');
		process.exit(2);
	}
	const changelog = readFileSync(join(import.meta.dirname, '..', 'CHANGELOG.md'), 'utf8');
	try {
		process.stdout.write(buildReleaseBody({ version, changelog, repo }));
	} catch (err) {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	}
}
