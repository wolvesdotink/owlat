/**
 * oxlint's `--format json` report, as the lint gates read it: the warning
 * ratchet (check-lint-warnings.ts), the owlat finding generator
 * (owlat-lint-findings.ts) and the AST-gate parity check (ast-gate-parity.ts).
 * Each of them turns a diagnostic into a baseline key or a site, so a report of
 * the wrong shape (an oxlint upgrade that renamed a field) must fail the gate
 * rather than produce keys that silently match nothing.
 */
import { arrayOf, decodeJson, type Decoder, integer, object, optional, string } from './json';

export interface LintDiagnostic {
	filename: string;
	/** Absent on oxlint's own reports, such as an unused disable directive. */
	code?: string;
	message: string;
	severity: string;
	/** Spans are byte offsets into the file; `line` is 1-based. */
	labels?: { span: { offset: number; length: number; line?: number } }[];
}

const decodeDiagnostic: Decoder<LintDiagnostic> = object({
	filename: string,
	code: optional(string),
	message: string,
	severity: string,
	labels: optional(
		arrayOf(object({ span: object({ offset: integer, length: integer, line: optional(integer) }) }))
	),
});

const decodeReport = object({ diagnostics: arrayOf(decodeDiagnostic) });

/** The diagnostics of one oxlint JSON report (its stdout). */
export function parseLintReport(stdout: string): LintDiagnostic[] {
	return decodeJson(stdout, decodeReport, 'oxlint report').diagnostics;
}
