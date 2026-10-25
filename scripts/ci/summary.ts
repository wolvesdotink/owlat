import { mkdirSync, writeFileSync } from 'node:fs';
import { assertJobResults, parseExpectedJobs, parseJobResults } from './selection';
const expected = parseExpectedJobs(process.env['CI_EXPECTED']);
const needs = parseJobResults(process.env['CI_NEEDS']);
assertJobResults(expected, needs);
mkdirSync('.ci-verification', { recursive: true });
writeFileSync(
	'.ci-verification/verification.json',
	JSON.stringify(
		{
			version: 1,
			sha: process.env['GITHUB_SHA'],
			repository: process.env['GITHUB_REPOSITORY'],
			runId: process.env['GITHUB_RUN_ID'],
			attempt: process.env['GITHUB_RUN_ATTEMPT'],
			full: process.env['CI_FULL'] === 'true',
			expected,
			results: Object.fromEntries(Object.entries(needs).map(([job, value]) => [job, value.result])),
		},
		null,
		2
	)
);
process.stdout.write('Every selected CI job succeeded.\n');
