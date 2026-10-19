/**
 * The compact Files card endpoints (`files.cards.list` / `search`).
 *
 * A card names its fields: none of the embedding vectors, extracted text,
 * search text or provenance columns of the row. The legacy
 * `semanticFiles.list` / `search` keep returning the whole row, and both read
 * the same index with the same cursor, so a page token from one is valid in
 * the other. Which rows a caller sees is pinned per session in
 * semanticFilesCaptureAccess.integration.test.ts.
 *
 * The last test records the encoded size of one 24-card page through both
 * endpoints. It reports the numbers and asserts no byte target.
 */

import { convexTest } from 'convex-test';
import { convexToJson, type Value } from 'convex/values';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { buildFileSearchableText } from '../lib/fileSearchText';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const modules = import.meta.glob('../**/*.*s');

type Harness = ReturnType<typeof convexTest>;

const CARD_KEYS = [
	'_id',
	'autoTags',
	'createdAt',
	'fileSize',
	'filename',
	'hasBytes',
	'mimeType',
	'sourceType',
	'summary',
	'tags',
	'title',
	'updatedAt',
	'url',
	'version',
];

/** Deterministic stand-in for a 1,536-dimension embedding. */
function vector(seed: number): number[] {
	let x = seed * 9301 + 49297;
	return Array.from({ length: 1536 }, () => {
		x = (x * 9301 + 49297) % 233280;
		return x / 233280 - 0.5;
	});
}

/** About `chars` characters of document-like text. */
function prose(seed: number, chars: number): string {
	const words = ['invoice', 'delivery', 'contract', 'quarter', 'renewal', 'schedule', 'budget'];
	const out: string[] = [];
	let length = 0;
	for (let i = 0; length < chars; i++) {
		const word = `${words[(seed + i) % words.length]}${i % 11 === 0 ? '.' : ''}`;
		out.push(word);
		length += word.length + 1;
	}
	return out.join(' ').slice(0, chars);
}

/** A processed file as the pipeline leaves it: summary, tags, text, vector. */
async function insertProcessedFile(
	t: Harness,
	i: number,
	overrides: Partial<Doc<'semanticFiles'>> = {}
): Promise<Id<'semanticFiles'>> {
	const filename = `q${(i % 4) + 1}-report-${i}.pdf`;
	const title = `Quarterly report ${i}`;
	const summary =
		'Revenue, churn and pipeline for the quarter, with the renewal schedule for the ' +
		'three largest accounts and the budget variance against plan.';
	const tags = ['reporting', `q${(i % 4) + 1}`];
	const autoTags = ['finance', 'quarterly'];
	const extractedText = prose(i, 12_000);
	const storageId = await t.run((ctx) => ctx.storage.store(new Blob([`file ${i}`])));
	return t.run((ctx) =>
		ctx.db.insert('semanticFiles', {
			storageId,
			filename,
			mimeType: 'application/pdf',
			fileSize: 180_000 + i,
			title,
			summary,
			extractedText,
			tags,
			autoTags,
			sourceType: 'upload',
			uploadedBy: 'test-user',
			uploadContext: JSON.stringify({ senderName: 'Ada', excerpt: 'Numbers attached.' }),
			version: 1,
			embedding: vector(i),
			embeddingModel: 'text-embedding-3-small',
			embeddingGeneratedAt: 1_000 + i,
			searchableText: buildFileSearchableText({
				filename,
				title,
				summary,
				tags,
				autoTags,
				extractedText,
			}),
			createdAt: 1_000 + i,
			updatedAt: 1_000 + i,
			...overrides,
		})
	);
}

/** Bytes of the JSON the Convex client receives for a query result. */
function encodedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(convexToJson(value as Value)), 'utf8');
}

describe('files.cards — the card shape', () => {
	it('returns only the named card fields, never vectors or extracted text', async () => {
		const t = convexTest(schema, modules);
		await insertProcessedFile(t, 1, {
			secondaryEmbedding: vector(2),
			secondaryEmbeddingGeneratedAt: 2_000,
			changeSummary: '≈3 paragraphs changed',
			sourceMessageId: '<m@example.com>',
		});

		const cards = await t.query(api.files.cards.list, {
			paginationOpts: { cursor: null, numItems: 10 },
		});
		expect(cards.page).toHaveLength(1);
		const card = cards.page[0]!;
		expect(Object.keys(card).sort()).toEqual(CARD_KEYS);
		expect(card).toMatchObject({
			filename: 'q2-report-1.pdf',
			title: 'Quarterly report 1',
			mimeType: 'application/pdf',
			sourceType: 'upload',
			tags: ['reporting', 'q2'],
			autoTags: ['finance', 'quarterly'],
			version: 1,
			hasBytes: true,
		});
		expect(typeof card.url).toBe('string');

		const searched = await t.query(api.files.cards.search, {
			paginationOpts: { cursor: null, numItems: 10 },
			query: 'quarterly',
		});
		expect(searched.page.map((c) => Object.keys(c).sort())).toEqual([CARD_KEYS]);
	});

	it('leaves optional fields out of a bare row instead of inventing them', async () => {
		const t = convexTest(schema, modules);
		await t.run((ctx) =>
			ctx.db.insert('semanticFiles', {
				filename: 'bare.txt',
				mimeType: 'text/plain',
				fileSize: 4,
				sourceType: 'agent_generated',
				version: 1,
				embedding: [],
				createdAt: 1,
				updatedAt: 1,
			})
		);

		const cards = await t.query(api.files.cards.list, {
			paginationOpts: { cursor: null, numItems: 10 },
		});
		expect(cards.page[0]).toEqual({
			_id: expect.any(String),
			filename: 'bare.txt',
			mimeType: 'text/plain',
			fileSize: 4,
			sourceType: 'agent_generated',
			version: 1,
			createdAt: 1,
			updatedAt: 1,
			// No storageId: the retention sweep released the bytes.
			hasBytes: false,
			url: null,
		});
	});

	it('keeps the legacy list returning the whole row', async () => {
		const t = convexTest(schema, modules);
		await insertProcessedFile(t, 1);

		const legacy = await t.query(api.semanticFiles.list, {
			paginationOpts: { cursor: null, numItems: 10 },
		});
		const row = legacy.page[0]!;
		expect(row.embedding).toHaveLength(1536);
		expect(row.extractedText).toHaveLength(12_000);
		expect(row.searchableText).toBeTruthy();
		expect(row.storageId).toBeTruthy();
		expect(typeof row.url).toBe('string');
	});
});

describe('files.cards — cursors', () => {
	it('walks the same rows in the same order as the legacy list, on either cursor', async () => {
		const t = convexTest(schema, modules);
		for (let i = 0; i < 5; i++) await insertProcessedFile(t, i);
		const opts = (cursor: string | null) => ({ paginationOpts: { cursor, numItems: 2 } });

		const legacyFirst = await t.query(api.semanticFiles.list, opts(null));
		const cardFirst = await t.query(api.files.cards.list, opts(null));
		expect(cardFirst.page.map((c) => c._id)).toEqual(legacyFirst.page.map((r) => r._id));
		expect(cardFirst.isDone).toBe(false);

		// A legacy page token continues the card list, and the reverse.
		const cardSecond = await t.query(api.files.cards.list, opts(legacyFirst.continueCursor));
		const legacySecond = await t.query(api.semanticFiles.list, opts(cardFirst.continueCursor));
		expect(cardSecond.page.map((c) => c._id)).toEqual(legacySecond.page.map((r) => r._id));

		const ids: string[] = [];
		let cursor: string | null = null;
		for (let guard = 0; guard < 10; guard++) {
			const res: { page: Array<{ _id: string }>; isDone: boolean; continueCursor: string } =
				await t.query(api.files.cards.list, opts(cursor));
			ids.push(...res.page.map((c) => c._id));
			if (res.isDone) break;
			cursor = res.continueCursor;
		}
		const newestFirst = await t.run((ctx) =>
			ctx.db.query('semanticFiles').withIndex('by_created_at').order('desc').collect()
		);
		expect(ids).toEqual(newestFirst.map((f) => f._id));
	});

	it('applies the sourceType filter across pages, as the legacy list does', async () => {
		const t = convexTest(schema, modules);
		await insertProcessedFile(t, 0, { sourceType: 'agent_generated' });
		for (let i = 1; i < 5; i++) await insertProcessedFile(t, i);

		const filenames: string[] = [];
		let cursor: string | null = null;
		for (let guard = 0; guard < 10; guard++) {
			const res: { page: Array<{ filename: string }>; isDone: boolean; continueCursor: string } =
				await t.query(api.files.cards.list, {
					paginationOpts: { cursor, numItems: 2 },
					sourceType: 'agent_generated',
				});
			filenames.push(...res.page.map((c) => c.filename));
			if (res.isDone) break;
			cursor = res.continueCursor;
		}
		expect(filenames).toEqual(['q1-report-0.pdf']);
	});
});

describe('files.cards — payload', () => {
	it('records the encoded size of a 24-card page, legacy against compact', async () => {
		const t = convexTest(schema, modules);
		for (let i = 0; i < 24; i++) await insertProcessedFile(t, i);
		const opts = { paginationOpts: { cursor: null, numItems: 24 } };

		const legacy = await t.query(api.semanticFiles.list, opts);
		const compact = await t.query(api.files.cards.list, opts);
		expect(compact.page.map((c) => c._id)).toEqual(legacy.page.map((r) => r._id));

		const legacyBytes = encodedBytes(legacy);
		const compactBytes = encodedBytes(compact);
		const legacyFields = Object.keys(legacy.page[0]!).length;
		const compactFields = Object.keys(compact.page[0]!).length;
		// Report only: the plan asks for measured numbers, not a byte target.
		process.stdout.write(
			`[files.cards payload] 24-card page: legacy ${legacyBytes} B (${legacyFields} fields/row), ` +
				`compact ${compactBytes} B (${compactFields} fields/row)\n`
		);
		expect(compactBytes).toBeGreaterThan(0);
	});
});
