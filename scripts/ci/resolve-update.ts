import { appendFileSync } from 'node:fs';
import { decodePublishedReleases, previousRelease } from './aliases';
import { githubPages, repository } from './github';
const previous = previousRelease(
	githubPages(`repos/${repository()}/releases?per_page=100`, decodePublishedReleases),
	process.env['VERSION'] ?? ''
);
appendFileSync(process.env['GITHUB_OUTPUT']!, `from=${previous}\n`);
