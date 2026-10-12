/**
 * Embedding provenance fixtures (ADR-0073). Vector search only returns rows
 * stamped with the active space, so a test that seeds vectors seeds a space
 * and stamps its rows with it.
 */
import type { convexTest } from 'convex-test';
import type { Id } from '../../_generated/dataModel';
import {
	embeddingSpaceEntryKey,
	embeddingSpaceIdentityKey,
} from '../../lib/aiRouting/embeddingKeys';
import type { EmbeddingSpaceIdentity } from '../../lib/aiRouting/embeddingKeys';

type T = ReturnType<typeof convexTest>;
type EntryType = Parameters<typeof embeddingSpaceEntryKey>[1];

/** The local default's space as a test registers it (no digest: an unprobed server). */
export const TEST_LOCAL_SPACE: EmbeddingSpaceIdentity = {
	provider: 'local',
	endpoint: 'http://ollama:11434',
	model: 'nomic-embed-text',
	dimensions: 1536,
};

/** Insert an embedding space (active, primary column unless told otherwise). */
export async function seedEmbeddingSpace(
	t: T,
	options: {
		identity?: EmbeddingSpaceIdentity;
		state?: 'active' | 'staged' | 'retired';
		slot?: 'primary' | 'secondary';
		activatedAt?: number;
		retiredAt?: number;
	} = {}
): Promise<Id<'embeddingSpaces'>> {
	const identity = options.identity ?? TEST_LOCAL_SPACE;
	const now = Date.now();
	return t.run((ctx) =>
		ctx.db.insert('embeddingSpaces', {
			...identity,
			identityKey: embeddingSpaceIdentityKey(identity),
			source: 'stored_config',
			state: options.state ?? 'active',
			slot: options.slot ?? 'primary',
			activatedAt: options.activatedAt ?? (options.state === 'staged' ? undefined : now),
			retiredAt: options.retiredAt,
			createdAt: now,
			updatedAt: now,
		})
	);
}

/** The primary-column stamp of a vector in `spaceId` (knowledge rows pass their type). */
export function stampedIn(spaceId: Id<'embeddingSpaces'>, entryType?: EntryType) {
	return {
		embeddingSpaceId: spaceId,
		embeddingProvenance: 'measured' as const,
		embeddingGeneratedAt: Date.now(),
		...(entryType ? { embeddingSpaceEntryKey: embeddingSpaceEntryKey(spaceId, entryType) } : {}),
	};
}

/** The space a job using the stored local default measures (for commit calls). */
export function measuredLocalSpace(dimensions: number = TEST_LOCAL_SPACE.dimensions) {
	return { ...TEST_LOCAL_SPACE, dimensions, source: 'stored_config' as const };
}

/** Store a local-embedder AI config (the local default unless `embeddingModel`). */
export async function configureLocalEmbedder(t: T, embeddingModel?: string): Promise<void> {
	const now = Date.now();
	await t.run(async (ctx) => {
		const existing = await ctx.db.query('aiProviderConfig').first();
		const fields = {
			languageProviderKind: 'openaiCompatible' as const,
			languageBaseUrl: 'http://localhost:11434/v1',
			modelFast: 'qwen3.6:27b',
			modelCapable: 'qwen3.6:27b',
			embeddingProviderKind: 'local' as const,
			embeddingModel,
			embeddingModelVersion: existing ? existing.embeddingModelVersion + 1 : 1,
			updatedAt: now,
		};
		if (existing) await ctx.db.patch(existing._id, fields);
		else await ctx.db.insert('aiProviderConfig', fields);
	});
}

/** The active space, seeded (local default, primary column) when there is none. */
export async function activeSpaceId(t: T): Promise<Id<'embeddingSpaces'>> {
	const existing = await t.run(async (ctx) =>
		(await ctx.db.query('embeddingSpaces').collect()).find((space) => space.state === 'active')
	);
	return existing?._id ?? (await seedEmbeddingSpace(t));
}

/**
 * Stamp every row that holds a vector but no space with the active space (seeded
 * when missing), as if a commit had measured it: for suites that seed vectors
 * through the shared factories.
 */
export async function stampLegacyVectors(t: T): Promise<Id<'embeddingSpaces'>> {
	const spaceId = await activeSpaceId(t);
	await t.run(async (ctx) => {
		for (const row of await ctx.db.query('knowledgeEntries').collect()) {
			if (row.embedding.length === 0 || row.embeddingSpaceId) continue;
			await ctx.db.patch(row._id, stampedIn(spaceId, row.entryType));
		}
		for (const row of await ctx.db.query('semanticFiles').collect()) {
			if (row.embedding.length === 0 || row.embeddingSpaceId) continue;
			await ctx.db.patch(row._id, stampedIn(spaceId));
		}
	});
	return spaceId;
}
