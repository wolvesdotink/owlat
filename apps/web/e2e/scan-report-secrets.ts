/**
 * CI gate before the Playwright report is uploaded (see .github/workflows/e2e.yml).
 *
 *   bun e2e/scan-report-secrets.ts <report-dir> [--storage-state <file>] <ENV_NAME>...
 *
 * Reads each named secret from the environment and searches the report for it
 * (`scanReportSecrets.ts`), and for the host of each one that is a URL. With
 * `--storage-state`, it also searches for the session cookies the setup project
 * saved there (`sessionSecrets.ts`). Whatever the arguments, it refuses any
 * JWT-shaped value and any trace archive: the Convex JWT is minted during the
 * run, and a trace records the session cookie, the JWT and the deployment URLs.
 *
 * It fails closed: on any finding, and on any error while scanning (an
 * unreadable storage state included), it deletes the report and exits 1. The
 * workflow only uploads after this step succeeds, so a report that could not be
 * deleted is not published either.
 *
 * Output names variables and a hashed id per finding (`findingId`), never a
 * secret's value or any path, the report directory's own included: a name can
 * carry an encoded secret.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { findingId, scanReport, type NamedSecret, type SecretFinding } from './scanReportSecrets';
import { storageStateSecrets, withUrlHosts } from './sessionSecrets';

const [dir, ...rest] = process.argv.slice(2);
let storageState: string | undefined;
if (rest[0] === '--storage-state') {
	storageState = rest[1];
	rest.splice(0, 2);
}
const names = rest;
if (!dir || names.length === 0 || (storageState !== undefined && !storageState)) {
	console.error(
		'usage: scan-report-secrets.ts <report-dir> [--storage-state <file>] <ENV_NAME>...'
	);
	process.exit(2);
}

if (!existsSync(dir)) {
	console.info('No report directory; nothing to scan.');
	process.exit(0);
}

const secrets = names.map((label) => ({ label, value: process.env[label] ?? '' }));
const missing = secrets.filter((secret) => !secret.value).map((secret) => secret.label);
if (missing.length > 0) console.info(`Not set, so not searched for: ${missing.join(', ')}`);

let findings: SecretFinding[];
try {
	const all: NamedSecret[] = withUrlHosts(secrets);
	if (storageState && existsSync(storageState)) {
		all.push(...storageStateSecrets(readFileSync(storageState, 'utf8')));
	} else if (storageState) {
		// The setup project failed before signing in, so no session cookie exists
		// to search for. Traces, which would hold one, are refused regardless.
		console.info('No storage state saved; no session cookies to search for.');
	}
	findings = scanReport(dir, { secrets: all, jwts: true, traces: true });
} catch {
	// The error could quote a path; it is not printed.
	console.error('::error::Scanning the report failed, so it cannot be published unchecked.');
	findings = [{ file: '.', label: 'unreadable' }];
}

if (findings.length === 0) {
	console.info('No secrets found in the report.');
	process.exit(0);
}

for (const [index, finding] of findings.entries()) {
	const what = finding.label === 'unreadable' ? 'something that could not be read' : finding.label;
	console.error(
		`::error::Report finding ${index + 1}: ${what} at location ${findingId(finding.file)}`
	);
}
try {
	rmSync(dir, { recursive: true, force: true });
	console.error('Deleted the report so it is not uploaded.');
} catch {
	console.error(
		'::error::Could not delete the report; the upload step is skipped because this one failed.'
	);
}
process.exit(1);
