import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { activeSpaceId, stampedIn } from './helpers/embeddingSpaces';

/**
 * files/processing.ts semanticSearch — now hybrid (vector + FTS via RRF),
 * mirroring knowledge/retrieval.ts. Uses convex-test's in-memory vectorSearch
 * (cosine) and search-index support. Embeddings are 1536-dim one-hot unit
 * vectors, so cosine(unit(i), unit(j)) is 1 when i===j and 0 otherwise — letting
 * us place files "near" or "far" from a query precisely.
 */

const modules = import.meta.glob('../**/*.*s');

const DIM = 1536;
function unit(at: number): number[] {
	const vec = Array.from({ length: DIM }, () => 0);
	vec[at] = 1;
	return vec;
}

type FileSpec = {
	filename: string;
	embedAt: number;
	searchableText?: string;
	contactIds?: Id<'contacts'>[];
	captureSource?: 'mailbox' | 'team_inbox';
};

async function insertFile(
	t: ReturnType<typeof convexTest>,
	spec: FileSpec
): Promise<Id<'semanticFiles'>> {
	const now = Date.now();
	const storageId = await t.run((ctx) =>
		ctx.storage.store(new Blob([spec.searchableText ?? spec.filename]))
	);
	const spaceId = await activeSpaceId(t);
	return await t.run((ctx) =>
		ctx.db.insert('semanticFiles', {
			storageId,
			filename: spec.filename,
			mimeType: 'text/plain',
			fileSize: (spec.searchableText ?? spec.filename).length,
			sourceType: spec.captureSource ? 'email_attachment' : 'upload',
			captureSource: spec.captureSource,
			contactIds: spec.contactIds,
			version: 1,
			embedding: unit(spec.embedAt),
			...stampedIn(spaceId),
			searchableText: spec.searchableText ?? spec.filename,
			createdAt: now,
			updatedAt: now,
		})
	);
}

async function insertContact(t: ReturnType<typeof convexTest>): Promise<Id<'contacts'>> {
	const now = Date.now();
	return await t.run((ctx) =>
		ctx.db.insert('contacts', {
			source: 'import',
			doiStatus: 'not_required',
			createdAt: now,
			updatedAt: now,
		})
	);
}

describe('files/processing.semanticSearch — hybrid (vector + FTS) recall', () => {
	it('surfaces an exact-token file the vector leg misses, via the FTS leg', async () => {
		const t = convexTest(schema, modules);
		// Flood the vector neighborhood of the query (embedAt 7) with decoys so a
		// vector-only search fills its window with them. The target shares NONE of
		// that embedding (orthogonal, embedAt 999) — pure vector ranks it last/out
		// — but its searchableText carries the exact order number we query for.
		for (let i = 0; i < 60; i++) {
			await insertFile(t, {
				filename: `decoy-${i}.txt`,
				embedAt: 7,
				searchableText: `unrelated chatter ${i}`,
			});
		}
		await insertFile(t, {
			filename: 'invoice.pdf',
			embedAt: 999,
			searchableText: 'tracking for order ABC-12345 shipped tuesday',
		});

		const results = await t.action(internal.files.processing.semanticSearch, {
			embeddingSpaceId: await activeSpaceId(t),
			queryText: 'ABC-12345',
			embedding: unit(7),
			scopeToContact: 'org-wide',
			mailCaptures: 'all',
			limit: 10,
		});

		// The exact-token hit makes the top results despite zero vector similarity.
		expect(results.map((r) => r.filename)).toContain('invoice.pdf');
	});

	it('still returns vector hits when there is no FTS match (graceful degrade)', async () => {
		const t = convexTest(schema, modules);
		await insertFile(t, {
			filename: 'concept.txt',
			embedAt: 3,
			searchableText: 'totally different words',
		});

		const results = await t.action(internal.files.processing.semanticSearch, {
			embeddingSpaceId: await activeSpaceId(t),
			queryText: 'zzzznomatch',
			embedding: unit(3),
			scopeToContact: 'org-wide',
			mailCaptures: 'all',
			limit: 10,
		});

		expect(results.map((r) => r.filename)).toContain('concept.txt');
	});
});

describe('files/processing.semanticSearch — contact-scope post-filter', () => {
	it('excludes a contact-B-only file under scope:contactA even when it is an FTS/vector hit', async () => {
		const t = convexTest(schema, modules);
		const contactA = await insertContact(t);
		const contactB = await insertContact(t);

		// Both files share the query token + vector neighborhood, so the only thing
		// that can keep B's file out of A's results is the post-fusion contact gate.
		await insertFile(t, {
			filename: 'a-contract.pdf',
			embedAt: 4,
			searchableText: 'shared secret token SKU-777',
			contactIds: [contactA],
		});
		await insertFile(t, {
			filename: 'b-contract.pdf',
			embedAt: 4,
			searchableText: 'shared secret token SKU-777',
			contactIds: [contactB],
		});

		const results = await t.action(internal.files.processing.semanticSearch, {
			embeddingSpaceId: await activeSpaceId(t),
			queryText: 'SKU-777',
			embedding: unit(4),
			scopeToContact: contactA,
			mailCaptures: 'all',
			limit: 10,
		});

		const names = results.map((r) => r.filename);
		expect(names).toContain('a-contract.pdf');
		expect(names).not.toContain('b-contract.pdf');
	});
});

describe('files/processing.semanticSearch — mail-capture scope (#1322)', () => {
	it('returns files captured from inbound mail only within the scope the caller names', async () => {
		const t = convexTest(schema, modules);
		const text = 'quarterly figures INV-9001';
		await insertFile(t, { filename: 'upload.pdf', embedAt: 5, searchableText: text });
		await insertFile(t, {
			filename: 'postbox.pdf',
			embedAt: 5,
			searchableText: text,
			captureSource: 'mailbox',
		});
		await insertFile(t, {
			filename: 'team.pdf',
			embedAt: 5,
			searchableText: text,
			captureSource: 'team_inbox',
		});

		const search = async (mailCaptures: 'none' | 'team_inbox' | 'all') =>
			(
				await t.action(internal.files.processing.semanticSearch, {
					embeddingSpaceId: await activeSpaceId(t),
					queryText: 'INV-9001',
					embedding: unit(5),
					scopeToContact: 'org-wide',
					mailCaptures,
					limit: 10,
				})
			)
				.map((r) => r.filename)
				.sort();

		expect(await search('none')).toEqual(['upload.pdf']);
		expect(await search('team_inbox')).toEqual(['team.pdf', 'upload.pdf']);
		expect(await search('all')).toEqual(['postbox.pdf', 'team.pdf', 'upload.pdf']);
	});
});
