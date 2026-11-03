import { appendFileSync } from 'node:fs';
import { repository } from './github';
import { findMainEvidence } from './main-evidence';
const repo = repository(),
	sha = process.env['GITHUB_SHA'];
if (!sha || !process.env['GITHUB_OUTPUT']) throw new Error('Missing Actions context');
const result = await findMainEvidence(repo, sha);
appendFileSync(process.env['GITHUB_OUTPUT'], `reused=${Boolean(result.run)}\n`);
const summary = result.run
	? `Verified exact commit using [main CI attempt ${result.run.run_attempt}](${result.run.html_url}).\n`
	: `${result.reason}; full shared CI will run.\n`;
if (process.env['GITHUB_STEP_SUMMARY']) appendFileSync(process.env['GITHUB_STEP_SUMMARY'], summary);
process.stdout.write(summary);
