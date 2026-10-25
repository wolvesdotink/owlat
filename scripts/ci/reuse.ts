import {
	arrayOf,
	boolean,
	decodeJson,
	type Decoder,
	integer,
	nullable,
	object,
	recordOf,
	string,
} from '../json';
import { assertJobResults } from './selection';
export const FULL_JOBS = [
	'detect',
	'lint',
	'typecheck',
	'ramp-gate-matrix',
	'test',
	'test-api',
	'test-api-merge',
	'test-web',
	'test-web-merge',
	'test-web-browser',
	'test-mta',
	'docker-build',
	'sdk-java',
	'desktop-spa',
];
export interface Verification {
	version: number;
	sha: string;
	repository: string;
	runId: string;
	attempt: string;
	full: boolean;
	expected: string[];
	results: Record<string, string>;
}
export interface Run {
	id: number;
	run_attempt: number;
	head_sha: string;
	/** GitHub leaves it null when the run has no branch or tag (a detached head). */
	head_branch: string | null;
	event: string;
	path: string;
	status: string;
	conclusion: string | null;
	created_at: string;
	html_url: string;
}
export const decodeRun: Decoder<Run> = object({
	id: integer,
	run_attempt: integer,
	head_sha: string,
	head_branch: nullable(string),
	event: string,
	path: string,
	status: string,
	conclusion: nullable(string),
	created_at: string,
	html_url: string,
});
/** A workflow's run list (`actions/workflows/<file>/runs`). */
export const decodeWorkflowRuns: Decoder<Run[]> = (value, path) =>
	object({ workflow_runs: arrayOf(decodeRun) })(value, path).workflow_runs;
const decodeVerification: Decoder<Verification> = object({
	version: integer,
	sha: string,
	repository: string,
	runId: string,
	attempt: string,
	full: boolean,
	expected: arrayOf(string),
	results: recordOf(string),
});
/** The `verification.json` a full main CI run uploads. */
export function parseVerification(text: string, label: string): Verification {
	return decodeJson(text, decodeVerification, label);
}
export function eligibleRun(run: Run, sha: string, now = Date.now()) {
	const age = now - Date.parse(run.created_at);
	return (
		run.head_sha === sha &&
		run.head_branch === 'main' &&
		run.event === 'push' &&
		run.path === '.github/workflows/test.yml' &&
		age >= 0 &&
		age <= 24 * 60 * 60 * 1000
	);
}
export function assertVerification(evidence: Verification, run: Run, repo: string) {
	if (
		evidence.version !== 1 ||
		!evidence.full ||
		evidence.sha !== run.head_sha ||
		evidence.repository !== repo ||
		evidence.runId !== String(run.id) ||
		evidence.attempt !== String(run.run_attempt)
	)
		throw new Error('Verification identity mismatch');
	if (
		evidence.expected.length !== FULL_JOBS.length ||
		FULL_JOBS.some((job) => !evidence.expected.includes(job))
	)
		throw new Error('Incomplete full verification contract');
	assertJobResults(
		evidence.expected,
		Object.fromEntries(Object.entries(evidence.results).map(([job, result]) => [job, { result }]))
	);
}
