import { execFileSync } from 'node:child_process';
import { github, repository } from './github';
import { verifyDesktopRelease, type DesktopManifest } from './desktop-manifest';
const repo = repository(),
	tag = process.env['RELEASE_TAG'],
	releaseId = process.env['RELEASE_ID'];
if (!tag || !releaseId) throw new Error('Missing release tag or ID');
verifyDesktopRelease(
	repo,
	tag,
	releaseId,
	github,
	(path) =>
		JSON.parse(
			execFileSync('gh', ['api', path, '-H', 'Accept: application/octet-stream'], {
				encoding: 'utf8',
				timeout: 60_000,
				maxBuffer: 1024 * 1024,
				stdio: ['ignore', 'pipe', 'pipe'],
			})
		) as DesktopManifest
);
