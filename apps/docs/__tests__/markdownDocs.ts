import { expect } from 'vitest';

/**
 * THE ONE MARKDOWN PARSER for the docs suites that pin a page's tables.
 *
 * Three suites read the same two pages, and each had grown its own `section` /
 * `tableRows` pair — already disagreeing before anyone noticed: one hard-coded
 * `/\n#{1,3} /` as the section terminator while another derived the heading
 * level from the heading it was given, and each carried its own separator-row
 * filter. `providerCatalogDocs` and `sendProviderAuthoringDocs` parse the *same*
 * table (the N+1 checklist on `15.providers.md`), so a markdown change could
 * pass one parser and break the other for reasons that have nothing to do with
 * the docs being wrong.
 *
 * That is the same defect `./catalogSource` exists to remove one level down —
 * two readers of one fact — so the fix is the same: one parser, imported.
 *
 * COLUMNS ARE RESOLVED BY HEADER TEXT, not by position ({@link columnIndex}).
 * A suite that hard-codes `cells[3]` as the `Required?` column silently
 * re-classifies every row the moment a column is inserted to its left, and the
 * failure surfaces on whichever *other* page compares against the mis-split
 * result — pointing at a file nobody edited.
 */

/** The body of one markdown section, up to the next heading of the same level. */
export function section(page: string, heading: string): string {
	const start = page.indexOf(`${heading}\n`);
	expect(start, `the page has no section "${heading}"`).toBeGreaterThan(-1);
	const level = heading.indexOf(' ');
	const rest = page.slice(start + heading.length);
	const next = rest.search(new RegExp(`\\n#{1,${level}} `));
	return next === -1 ? rest : rest.slice(0, next);
}

/** One table line's cells, trimmed, with the leading and trailing `|` dropped. */
export function rowCells(line: string): string[] {
	return line
		.split('|')
		.slice(1, -1)
		.map((cell) => cell.trim());
}

const isSeparator = (line: string) => /^\|[\s:-]+\|/.test(line);

/**
 * The lines of the FIRST markdown table in `body`, separator dropped.
 *
 * "First" is load-bearing and was not always true: an earlier version filtered
 * every `|`-leading line in the section, so a second table added below (a
 * per-kind quota table, say) had its rows appended to the first table's and the
 * positional cell reads started answering about the wrong columns — a failure
 * that reads as "the catalog drifted" when nothing about the catalog changed.
 * A markdown table is a run of consecutive `|` lines, so the run is where it
 * stops.
 */
function tableLines(body: string): string[] {
	const lines = body.split('\n');
	const start = lines.findIndex((line) => line.startsWith('|'));
	if (start === -1) return [];
	let end = start;
	while (end < lines.length && lines[end]!.startsWith('|')) end += 1;
	return lines.slice(start, end).filter((line) => !isSeparator(line));
}

/** The header cells of the first markdown table in `body`. */
export function tableHeader(body: string): string[] {
	const [header] = tableLines(body);
	expect(header, 'the section carries no markdown table').toBeDefined();
	return rowCells(header!);
}

/** The rows of the first markdown table in `body`, header dropped. */
export function tableRows(body: string): string[][] {
	return tableLines(body).slice(1).map(rowCells);
}

/**
 * The position of a column, BY ITS HEADER TEXT — matched on the header cell's
 * leading words so `Required?` is found whether or not it later grows a
 * footnote. A header this cannot find is a failure, not a `-1` that quietly
 * reads cell `undefined` as "not optional".
 */
export function columnIndex(header: readonly string[], name: string): number {
	const at = header.findIndex((cell) => cell === name || cell.startsWith(`${name} `));
	expect(at, `the table has no "${name}" column (header: ${header.join(' | ')})`).toBeGreaterThan(
		-1
	);
	return at;
}

/** Every `` `token` `` in a cell, in order. */
export function codeSpans(cell: string): string[] {
	return [...cell.matchAll(/`([^`]+)`/g)].map((hit) => hit[1]!);
}

/** Every `` `ENV_VAR` `` (SCREAMING_SNAKE) token in a cell, in order. */
export function envVarSpans(cell: string): string[] {
	return [...cell.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((hit) => hit[1]!);
}
