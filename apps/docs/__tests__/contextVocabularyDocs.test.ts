import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './repoVocabulary';

/**
 * The two conventions the repo-root `CONTEXT.md` navigates by.
 *
 * `CONTEXT.md` "pins the project-specific language used across architecture
 * decisions", and it is addressed by two greppable spellings that nothing else
 * can validate: `**§ Section name**` to point at one of its own sections, and
 * `ADR-NNNN` to cite a decision record. Both are conventions rather than links,
 * so a rename or a renumber breaks them silently — `lint:adr` guarantees one
 * document per ADR number, but nothing guaranteed that a citation named a
 * number with a document behind it.
 *
 * What this file no longer does is re-state the file's prose. It used to pin
 * every counted list and every adapter-family table in `CONTEXT.md` against the
 * registry it counts, in 560 lines; the names those sections cite are now
 * checked, along with the whole docs corpus, by `docsVocabulary.test.ts`.
 */

const context = readFileSync(resolve(REPO_ROOT, 'CONTEXT.md'), 'utf8');

/** Every `## ` heading, in file order. */
const sectionHeadings = [...context.matchAll(/^## (.+)$/gm)].map((match) => match[1]!.trim());

/**
 * The body of one `## ` section: everything up to the next `## ` heading.
 *
 * Sections are addressed BY NAME because that is what a cross-reference names.
 * A section this helper cannot find is a failure rather than an empty string —
 * an assertion against `''` passes for `not.toContain` and fails silently for
 * everything else, which is the exact failure mode the file exists to catch.
 */
function section(name: string): string {
	const heading = `\n## ${name}\n`;
	const start = context.indexOf(heading);
	expect(start, `CONTEXT.md has no "## ${name}" section`).toBeGreaterThan(-1);
	const rest = context.slice(start + heading.length);
	const next = rest.indexOf('\n## ');
	return next === -1 ? rest : rest.slice(0, next);
}

/**
 * A cross-reference inside backticks is a QUOTATION of the convention (the note
 * at the top of the file is one), not a reference to a section, and must not be
 * resolved as one.
 */
function prose(text: string): string {
	return text.replace(/`[^`]*`/g, '');
}

/**
 * Every `**§ Section**` reference in a body, by section name.
 *
 * Interior whitespace is COLLAPSED because the file is hand-wrapped at ~80
 * columns and a two-word section name straddles a line break sooner or later.
 * Matching the raw capture would report that wrap as a dangling reference,
 * which trains the next author to either widen the line or delete the check.
 */
function referencesIn(body: string): string[] {
	return [...prose(body).matchAll(/\*\*§ ([^*]+)\*\*/g)].map((match) =>
		match[1]!.replace(/\s+/g, ' ').trim()
	);
}

describe('CONTEXT.md: section cross-references resolve', () => {
	const references = referencesIn(context);

	it('finds the cross-references it is meant to check', () => {
		// Non-triviality: a regex that matched nothing would agree with every
		// broken reference in the file.
		expect(references.length).toBeGreaterThanOrEqual(5);
	});

	it('every `**§ Section**` reference names a real section', () => {
		const dangling = [...new Set(references)].filter((name) => !sectionHeadings.includes(name));
		expect(dangling, `no "## " heading for: ${dangling.join(', ')}`).toEqual([]);
	});

	it('no section cross-references itself', () => {
		// A self-reference is always a copy-paste, and always sends a reader in a
		// circle rather than to the section that actually holds the answer.
		const selfReferencing = sectionHeadings.filter((name) =>
			referencesIn(section(name)).includes(name)
		);
		expect(selfReferencing).toEqual([]);
	});
});

describe('CONTEXT.md: ADR citations resolve', () => {
	const adrFiles = readdirSync(resolve(REPO_ROOT, 'docs/adr'));
	const cited = [...new Set([...context.matchAll(/ADR-(\d{4})/g)].map((match) => match[1]!))];

	it('finds the citations it is meant to check', () => {
		expect(cited.length).toBeGreaterThan(5);
	});

	it('every cited ADR number has a document', () => {
		const missing = cited.filter((number) => !adrFiles.some((f) => f.startsWith(`${number}-`)));
		expect(missing, `no docs/adr/${missing.join('|')}-*.md`).toEqual([]);
	});
});
