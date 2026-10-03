/**
 * CI gate before the Playwright report is uploaded (see .github/workflows/e2e.yml).
 *
 *   bun e2e/scan-report-secrets.ts <report-dir> <ENV_NAME>...
 *
 * Reads each named secret from the environment and searches the report for it
 * (`scanReportSecrets.ts`). It fails closed: on any finding, and on any error
 * while scanning, it deletes the report and exits 1. The workflow only uploads
 * after this step succeeds, so a report that could not be deleted is not
 * published either.
 *
 * Output names variables and a hashed id per finding (`findingId`), never a
 * secret's value or a path: a file name can carry an encoded secret.
 */
import { existsSync, rmSync } from 'node:fs';
import { findSecretsInReport, findingId, type SecretFinding } from './scanReportSecrets';

const [dir, ...names] = process.argv.slice(2);
if (!dir || names.length === 0) {
	console.error('usage: scan-report-secrets.ts <report-dir> <ENV_NAME>...');
	process.exit(2);
}

if (!existsSync(dir)) {
	console.info(`No report at ${dir}; nothing to scan.`);
	process.exit(0);
}

const secrets = names.map((label) => ({ label, value: process.env[label] ?? '' }));
const missing = secrets.filter((secret) => !secret.value).map((secret) => secret.label);
if (missing.length > 0) console.info(`Not set, so not searched for: ${missing.join(', ')}`);

let findings: SecretFinding[];
try {
	findings = findSecretsInReport(dir, secrets);
} catch {
	// The error could quote a path; it is not printed.
	console.error(`::error::Scanning ${dir} failed, so it cannot be published unchecked.`);
	findings = [{ file: '.', label: 'unreadable' }];
}

if (findings.length === 0) {
	console.info(`No secrets found in ${dir}.`);
	process.exit(0);
}

for (const [index, finding] of findings.entries()) {
	const what = finding.label === 'unreadable' ? 'something that could not be read' : finding.label;
	console.error(
		`::error::${dir} finding ${index + 1}: ${what} at location ${findingId(finding.file)}`
	);
}
try {
	rmSync(dir, { recursive: true, force: true });
	console.error(`Deleted ${dir} so it is not uploaded.`);
} catch {
	console.error(
		`::error::Could not delete ${dir}; the upload step is skipped because this one failed.`
	);
}
process.exit(1);
