/**
 * The two derived keys of embedding provenance. Pure, so the writer
 * that stamps a row, the job that re-embeds it and the retrieval that filters
 * on it all spell them the same way.
 */

import type { Infer, ObjectType } from 'convex/values';
import type { Id } from '../../_generated/dataModel';
import type { embeddingSpaceIdentityFields } from '../validators/embedding';
import type { entryTypeValidator } from '../../schema/knowledge';

export type EmbeddingSpaceIdentity = ObjectType<typeof embeddingSpaceIdentityFields>;

/**
 * The canonical identity string of an embedding space, stored on
 * `embeddingSpaces.identityKey` and looked up through `by_identity_key`, so
 * registering the space a writer resolved is idempotent. A JSON array, so no
 * separator inside a model id or an origin can make two identities collide.
 * Absent revision and quantization are part of the identity: a later digest
 * capture is a different (better-identified) space, not the same one.
 */
export function embeddingSpaceIdentityKey(identity: EmbeddingSpaceIdentity): string {
	return JSON.stringify([
		identity.provider,
		identity.endpoint,
		identity.model,
		identity.dimensions,
		identity.revision ?? null,
		identity.quantization ?? null,
	]);
}

/**
 * The composite vector-filter key of a knowledge entry: Convex vector filters
 * can OR but not AND, so "this space AND this entry type" is one field. Written
 * beside `embeddingSpaceId` (and the secondary column's beside its space id).
 */
export function embeddingSpaceEntryKey(
	spaceId: Id<'embeddingSpaces'>,
	entryType: Infer<typeof entryTypeValidator>
): string {
	return `${spaceId}:${entryType}`;
}
