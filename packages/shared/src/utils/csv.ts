/**
 * Neutralize spreadsheet formula injection in a CSV cell value.
 *
 * Excel / LibreOffice / Google Sheets interpret cells beginning with
 * `=`, `+`, `-`, `@` (or a tab/CR-prefixed variant) as formulas, so an
 * attacker-supplied value like `=HYPERLINK(...)` or `=cmd|' /C calc'!A0`
 * executes when an exported file is opened. Per OWASP, prefix such cells
 * with a single quote — spreadsheets then render the literal text.
 *
 * Apply to every untrusted value (contact names, custom properties, …)
 * before it is handed to the CSV serializer; quoting alone (PapaParse)
 * does NOT prevent formula evaluation.
 */
export function sanitizeCsvCell(value: string): string {
	if (/^[=+\-@\t\r]/.test(value)) {
		return `'${value}`;
	}
	return value;
}
