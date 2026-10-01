import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIT_ACTION_LITERALS, AUDIT_RESOURCE_LITERALS } from '../catalog';

/**
 * Parity guard: `docs/audit-log-actions.md` is the only place that says what
 * `details` each audit action carries, so its action table has to name exactly
 * the literals in `AUDIT_ACTION_LITERALS`. Nothing else ties the two together,
 * and before this check they had drifted apart by a third of the catalog.
 *
 * The `details` column stays hand-written; only the action and resource
 * columns are checked.
 */
const DOC_PATH = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../../docs/audit-log-actions.md'
);
const TABLE_HEADING = '## Action catalog';

interface CatalogRow {
	readonly line: number;
	readonly actions: string[];
	readonly resources: string[];
}

/** Split one markdown table row into cells. `\|` inside a cell is not a separator. */
function splitCells(row: string): string[] {
	return row
		.trim()
		.replace(/^\|/, '')
		.replace(/(?<!\\)\|$/, '')
		.split(/(?<!\\)\|/)
		.map((cell) => cell.trim());
}

function codeSpans(cell: string): string[] {
	return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
}

/** The body rows of the table under `## Action catalog` (header and separator dropped). */
function parseActionTable(markdown: string): CatalogRow[] {
	const lines = markdown.split('\n');
	const start = lines.findIndex((line) => line.trim() === TABLE_HEADING);
	if (start === -1) throw new Error(`no "${TABLE_HEADING}" heading`);
	const rows: CatalogRow[] = [];
	let sawHeader = false;
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (line.startsWith('## ')) break;
		if (!line.trim().startsWith('|')) continue;
		const cells = splitCells(line);
		if (!sawHeader) {
			sawHeader = true;
			continue;
		}
		if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
		rows.push({
			line: i + 1,
			actions: codeSpans(cells[0] ?? ''),
			resources: codeSpans(cells[1] ?? ''),
		});
	}
	return rows;
}

interface ParityReport {
	readonly undocumented: string[];
	readonly unknown: string[];
	readonly duplicated: string[];
	readonly unknownResources: string[];
	readonly rowsWithoutAction: number[];
	readonly rowsWithoutResource: number[];
}

function compareWithCatalog(
	rows: ReadonlyArray<CatalogRow>,
	actions: ReadonlyArray<string>,
	resources: ReadonlyArray<string>
): ParityReport {
	const documented = rows.flatMap((row) => row.actions);
	const documentedSet = new Set(documented);
	const actionSet = new Set(actions);
	const resourceSet = new Set(resources);
	return {
		undocumented: actions.filter((action) => !documentedSet.has(action)),
		unknown: [...documentedSet].filter((action) => !actionSet.has(action)),
		duplicated: [...documentedSet].filter(
			(action) => documented.indexOf(action) !== documented.lastIndexOf(action)
		),
		unknownResources: [
			...new Set(rows.flatMap((row) => row.resources).filter((r) => !resourceSet.has(r))),
		],
		rowsWithoutAction: rows.filter((row) => row.actions.length === 0).map((row) => row.line),
		rowsWithoutResource: rows.filter((row) => row.resources.length === 0).map((row) => row.line),
	};
}

const CLEAN: ParityReport = {
	undocumented: [],
	unknown: [],
	duplicated: [],
	unknownResources: [],
	rowsWithoutAction: [],
	rowsWithoutResource: [],
};

describe('audit-log action doc parity', () => {
	const rows = parseActionTable(readFileSync(DOC_PATH, 'utf8'));

	it('reads a non-trivial table', () => {
		expect(rows.length).toBeGreaterThan(50);
	});

	it('documents every catalog action exactly once, and nothing else', () => {
		expect(compareWithCatalog(rows, AUDIT_ACTION_LITERALS, AUDIT_RESOURCE_LITERALS)).toEqual(CLEAN);
	});
});

describe('parity check', () => {
	const doc = [
		'# Title',
		'',
		TABLE_HEADING,
		'',
		'| Action | Resource | Expected `details` |',
		'| ------ | -------- | ------------------ |',
		'| `a.created` / `a.deleted` | `a` | `{ name }` |',
		'| `b.changed` | `b` | `{ from \\| to }` |',
		'',
		'## Extending',
		'',
		'| `c.ignored` | `c` | outside the catalog section |',
	].join('\n');

	it('parses full literals, skips the header and stops at the next section', () => {
		expect(parseActionTable(doc).map(({ actions, resources }) => ({ actions, resources }))).toEqual(
			[
				{ actions: ['a.created', 'a.deleted'], resources: ['a'] },
				{ actions: ['b.changed'], resources: ['b'] },
			]
		);
	});

	it('reports a catalog action with no row', () => {
		const report = compareWithCatalog(
			parseActionTable(doc),
			['a.created', 'a.deleted', 'b.changed', 'b.added'],
			['a', 'b']
		);
		expect(report).toEqual({ ...CLEAN, undocumented: ['b.added'] });
	});

	it('reports a row naming an action or resource the catalog does not have', () => {
		const report = compareWithCatalog(parseActionTable(doc), ['a.created', 'a.deleted'], ['a']);
		expect(report).toEqual({ ...CLEAN, unknown: ['b.changed'], unknownResources: ['b'] });
	});

	it('reports an action documented in two rows', () => {
		const twice = doc.replace('`b.changed`', '`a.created`');
		const report = compareWithCatalog(
			parseActionTable(twice),
			['a.created', 'a.deleted'],
			['a', 'b']
		);
		expect(report).toEqual({ ...CLEAN, duplicated: ['a.created'] });
	});
});
