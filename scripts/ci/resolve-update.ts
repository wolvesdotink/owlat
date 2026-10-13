import { appendFileSync } from 'node:fs';
import { previousRelease, type PublishedRelease } from './aliases';
import { githubPages, repository } from './github';
const previous = previousRelease(
	githubPages<PublishedRelease>(`repos/${repository()}/releases?per_page=100`),
	process.env['VERSION'] ?? ''
);
appendFileSync(process.env['GITHUB_OUTPUT']!, `from=${previous}\n`);
