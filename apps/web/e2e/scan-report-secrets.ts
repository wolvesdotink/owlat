/**
 * CI gate before the Playwright report is uploaded (see .github/workflows/e2e.yml).
 *
 *   bun e2e/scan-report-secrets.ts <report-dir> <ENV_NAME>...
 *
 * Reads each named secret from the environment and searches the report for it
 * (`scanReportSecrets.ts`). On any finding it deletes the report, so the upload
 * step finds nothing to publish, and exits 1. Output names files and variables,
 * never a secret's value.
 */
import { existsSync, rmSync } from 'node:fs';
import { findSecretsInReport } from './scanReportSecrets';

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

const findings = findSecretsInReport(dir, secrets);
if (findings.length === 0) {
	console.info(`No secrets found in ${dir}.`);
	process.exit(0);
}

for (const finding of findings) {
	const what = finding.label === 'unreadable' ? 'an archive that could not be read' : finding.label;
	console.error(`::error::${dir}/${finding.file} contains ${what}`);
}
rmSync(dir, { recursive: true, force: true });
console.error(`Deleted ${dir} so it is not uploaded.`);
process.exit(1);
