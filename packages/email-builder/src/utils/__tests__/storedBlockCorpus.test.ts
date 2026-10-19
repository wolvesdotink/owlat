import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderEmailHtml } from '@owlat/email-renderer';
import { describe, expect, it } from 'vitest';
import { parseStoredBlocks } from '../storedBlocks';

// The stored EditorBlock corpus (packages/email-renderer/src/__tests__/
// storedBlocks, rules in its corpus.ts) loaded the way the editors load a row:
// every template, transactional email and saved Block reads back as Blocks with
// ids and renders. Saved Blocks reach a render only through this reader.

const CORPUS_DIR = resolve(
	import.meta.dirname,
	'../../../../email-renderer/src/__tests__/storedBlocks'
);

/** Columns the editors read with `parseStoredBlocks`; drafts load elsewhere. */
const EDITOR_FIELDS = new Set([
	'emailTemplates.content',
	'transactionalEmails.content',
	'emailBlocks.content',
]);

const fixtures = readdirSync(CORPUS_DIR)
	.filter((dir) => /^v\d+$/.test(dir))
	.flatMap((dir) =>
		readdirSync(join(CORPUS_DIR, dir))
			.filter((file) => file.endsWith('.json'))
			.map((file) => {
				const raw = JSON.parse(readFileSync(join(CORPUS_DIR, dir, file), 'utf8')) as {
					field: string;
					stored: unknown;
				};
				return { name: `${dir}/${file}`, field: raw.field, stored: raw.stored };
			})
	)
	.filter((fixture) => EDITOR_FIELDS.has(fixture.field));

describe('stored EditorBlock corpus in the editor', () => {
	it('has fixtures for every editor-read column', () => {
		expect(new Set(fixtures.map((fixture) => fixture.field))).toEqual(EDITOR_FIELDS);
	});

	it.each(fixtures)('$name loads with ids and renders', ({ stored }) => {
		const blocks = parseStoredBlocks(JSON.stringify(stored));
		const entries = Array.isArray(stored)
			? stored
			: Array.isArray((stored as { blocks?: unknown }).blocks)
				? (stored as { blocks: unknown[] }).blocks
				: [stored];

		expect(blocks).toHaveLength(entries.length);
		for (const block of blocks) expect(block.id).toBeTypeOf('string');
		expect(renderEmailHtml(blocks)).toContain('</html>');
	});
});
