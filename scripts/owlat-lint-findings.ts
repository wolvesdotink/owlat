/**
 * Generator for the owlat lint ratchet (scripts/check-owlat-lint.sh): prints
 * one line per warning an `owlat/*` rule (packages/oxlint-plugin-owlat) reports,
 * for scripts/ratchet.sh to compare against scripts/owlat-lint-baseline.txt.
 *
 * A rule that lands with no remaining offenders is configured as an error in
 * oxlintrc.json and every lint run enforces it outright. A rule that lands with
 * debt is configured as a warning instead; its current offenders are seeded
 * into the baseline and this ratchet is the one gate that owns them: a new
 * finding fails, and a fixed one must be deleted from the baseline.
 * scripts/check-lint-warnings.ts leaves owlat warnings to this gate.
 *
 * Line format: `<file>\t<rule>\t<source text of the reported span>`. No line or
 * column, so an unrelated edit above a finding does not churn the baseline;
 * one line per finding, so two identical findings in a file count twice.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOwlatWarning, type LintDiagnostic } from './check-lint-warnings';

const SNIPPET_LIMIT = 160;

/** The ratchet line for one finding; `source` is the file's bytes (spans are byte offsets). */
export function findingLine(diagnostic: LintDiagnostic, source: Buffer): string {
	const span = diagnostic.labels?.[0]?.span;
	const snippet = span
		? source
				.subarray(span.offset, span.offset + span.length)
				.toString('utf8')
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, SNIPPET_LIMIT)
				.trimEnd()
		: '';
	return [diagnostic.filename, diagnostic.code ?? '', snippet].join('\t');
}

function main(): number {
	const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
	const run = spawnSync(
		'bunx',
		[
			'--no-install',
			'oxlint',
			'--config',
			'oxlintrc.json',
			'--format',
			'json',
			'apps',
			'packages',
			'scripts',
			'examples',
		],
		{ cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
	);
	// oxlint exits 1 when it reports anything; any other outcome means it did
	// not finish, and an empty finding set from a crashed run must not pass.
	if (run.error || run.signal || (run.status !== 0 && run.status !== 1)) {
		console.error(run.error ?? run.stderr ?? 'oxlint failed');
		return 2;
	}
	const report = JSON.parse(run.stdout) as { diagnostics?: LintDiagnostic[] };
	if (!Array.isArray(report.diagnostics)) {
		console.error('oxlint printed no diagnostics array');
		return 2;
	}
	for (const diagnostic of report.diagnostics.filter(isOwlatWarning)) {
		const filename = resolve(root, diagnostic.filename);
		console.info(
			findingLine({ ...diagnostic, filename: relative(root, filename) }, readFileSync(filename))
		);
	}
	return 0;
}

if (import.meta.main) process.exitCode = main();
