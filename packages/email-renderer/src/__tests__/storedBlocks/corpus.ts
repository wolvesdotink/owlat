/**
 * Stored-shape corpus for the `EditorBlock[]` JSON (`contentBlockVersion`).
 *
 * apps/api/convex/CONVENTIONS.md ("Versioning rules") requires this renderer
 * to render every historical `contentBlockVersion`, or a migration to retire
 * one. Each `v<N>/*.json` file is one stored document of version N, in the
 * shape a writer actually stored: `stored` is the value whose `JSON.stringify`
 * is the row's string column, `field` names that column. Only version 1 exists
 * today; its fixtures cover what earlier v1 writers left out (fields added
 * later, sparse seed content, pre-normalization numeric strings, ids repeated
 * before #1083) and the three envelopes a row can hold.
 *
 * The rules (storedBlockCorpus.test.ts and apps/api's storedBlockCorpus test
 * enforce them, scripts/check-stored-block-corpus.ts guards the history):
 * - A fixture is a record of what was stored. Add new ones; never edit one.
 * - `snapshots/renderer-v<EMAIL_RENDERER_VERSION>/` holds each fixture's HTML.
 *   A snapshot that exists is never rewritten: HTML that changes means a new
 *   EMAIL_RENDERER_VERSION, a new snapshot directory and the old one deleted.
 * - Retiring a `contentBlockVersion` deletes its `v<N>/` directory and records
 *   the migration that rewrote its rows in `retired.json`
 *   (`{ "<N>": "migrations/<file>.ts" }`).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EditorBlock, VariableType } from '@owlat/shared';
import { renderDraftBodies } from '../../draftBodies';
import { renderPlainText } from '../../plaintext';
import { renderEmailHtml } from '../../renderer';

export const CORPUS_DIR = dirname(fileURLToPath(import.meta.url));
export const SNAPSHOTS_DIR = resolve(CORPUS_DIR, 'snapshots');

/**
 * Every stored column the corpus covers, with the variable syntax its server
 * render uses (lib/publishableEmailRender.ts). Saved Blocks are rendered inside
 * templates; drafts go through `renderDraftBodies`, which takes none.
 */
const STORED_FIELDS = {
	'emailTemplates.content': 'personalization',
	'transactionalEmails.content': 'data',
	'emailBlocks.content': 'personalization',
	'mailDrafts.bodyBlocks': undefined,
} as const satisfies Record<string, VariableType | undefined>;

type StoredField = keyof typeof STORED_FIELDS;

export interface StoredBlockFixture {
	/** File name without `.json`; also the snapshot's name. */
	name: string;
	contentBlockVersion: number;
	description: string;
	field: StoredField;
	/** The column's string, exactly as the row holds it. */
	stored: string;
}

export interface RenderedFixture {
	html: string;
	text: string;
	amp?: string;
}

/** The `v<N>` directories present, as version numbers. */
export function corpusVersions(): number[] {
	return readdirSync(CORPUS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^v\d+$/.test(entry.name))
		.map((entry) => Number(entry.name.slice(1)))
		.toSorted((a, b) => a - b);
}

export function loadStoredBlockCorpus(): StoredBlockFixture[] {
	return corpusVersions().flatMap((version) => {
		const dir = join(CORPUS_DIR, `v${version}`);
		return readdirSync(dir)
			.filter((file) => file.endsWith('.json'))
			.toSorted()
			.map((file) => {
				const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
					description: string;
					field: string;
					stored: unknown;
				};
				if (!(raw.field in STORED_FIELDS)) {
					throw new Error(`${file}: unknown stored field "${raw.field}"`);
				}
				return {
					name: file.slice(0, -'.json'.length),
					contentBlockVersion: version,
					description: raw.description,
					field: raw.field as StoredField,
					stored: JSON.stringify(raw.stored),
				};
			});
	});
}

/**
 * How a stored block column is read before it is rendered: the `{ blocks }`
 * envelope, a bare array or one legacy `{ type, content }` Block, as
 * `parseContentBlocks` (apps/api/convex/emailBlocks/module.ts) reads a
 * template for the server render. The API's corpus test renders the template
 * fixtures through that server path and compares the result with these
 * snapshots, so the two readings cannot drift apart unnoticed.
 *
 * A saved Block is only ever rendered after the editor read it with
 * `parseStoredBlocks` (@owlat/email-builder), which gives an entry without an
 * id a fresh one; here it gets a fixed id so the snapshot stays stable.
 */
function decodeStoredBlocks(fixture: StoredBlockFixture): EditorBlock[] {
	const parsed = JSON.parse(fixture.stored);
	let blocks: EditorBlock[] = [];
	if (Array.isArray(parsed?.blocks)) blocks = parsed.blocks;
	else if (Array.isArray(parsed)) blocks = parsed;
	else if (parsed?.type && parsed?.content) blocks = [parsed];
	if (fixture.field !== 'emailBlocks.content') return blocks;
	return blocks.map((block, index) =>
		typeof block.id === 'string' ? block : { ...block, id: `${fixture.name}-${index}` }
	);
}

/**
 * The one random part of the output: each carousel draws a fresh
 * `owlat-car-<id>` class prefix per render (blocks/carousel/index.ts).
 */
export function stableHtml(html: string): string {
	return html.replace(/owlat-car-[a-z0-9]+/g, 'owlat-car-RANDOM');
}

/** Render a fixture the way its stored column is rendered for sending. */
export function renderStoredFixture(fixture: StoredBlockFixture): RenderedFixture {
	if (fixture.field === 'mailDrafts.bodyBlocks') {
		const bodies = renderDraftBodies(
			{ composerMode: 'full', bodyBlocks: fixture.stored },
			{
				onBlockParseError: (err) => {
					throw err;
				},
			}
		);
		return { ...bodies, html: stableHtml(bodies.html) };
	}
	const blocks = decodeStoredBlocks(fixture);
	return {
		html: stableHtml(renderEmailHtml(blocks, { variableType: STORED_FIELDS[fixture.field] })),
		text: renderPlainText(blocks),
	};
}
