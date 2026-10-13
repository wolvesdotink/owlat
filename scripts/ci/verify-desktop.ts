import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { github, repository } from './github';
import { assertDesktopManifest, type DesktopManifest } from './desktop-manifest';
const repo = repository(),
	tag = process.env['RELEASE_TAG'];
if (!tag) throw new Error('Missing release tag');
const directory = mkdtempSync(join(tmpdir(), 'owlat-desktop-'));
try {
	execFileSync(
		'gh',
		['release', 'download', tag, '--repo', repo, '--pattern', 'latest.json', '--dir', directory],
		{ stdio: 'pipe' }
	);
	const assets = github<{ assets: { url: string; browser_download_url: string }[] }>(
		`repos/${repo}/releases/tags/${tag}`
	).assets;
	assertDesktopManifest(
		JSON.parse(readFileSync(join(directory, 'latest.json'), 'utf8')) as DesktopManifest,
		tag,
		repo,
		assets.flatMap((asset) => [asset.url, asset.browser_download_url])
	);
} finally {
	rmSync(directory, { recursive: true, force: true });
}
