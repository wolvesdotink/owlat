import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { captureSourceValidator, semanticFileSourceTypeValidator } from '../lib/literalValidators';
import {
	embeddingProvenanceFields,
	embeddingSecondarySlotFields,
} from '../lib/validators/embedding';

/**
 * Semantic files: files with embeddings, auto-tags and version tracking, and
 * their contact junction. Split out of `schema/knowledge.ts` at the size cap;
 * `knowledgeTables` spreads these, so `schema.ts` is unchanged.
 */
export const semanticFileTables = {
	// Semantic Files - files with embeddings, auto-tags, and version tracking
	semanticFiles: defineTable({
		// OPTIONAL because the retention sweep RELEASES BYTES WITHOUT DELETING THE
		// ROW: past the configured horizon an `email_attachment` file's blob is
		// deleted and this reference cleared, while `summary`, `extractedText`,
		// `searchableText` and `embedding` survive so `[RELEVANT FILES]` retrieval
		// keeps working. Absent ⇒ the bytes are gone; every reader treats that as
		// a first-class state (no URL, no re-extraction, not offered as an
		// attachment suggestion).
		storageId: v.optional(v.id('_storage')),
		filename: v.string(),
		mimeType: v.string(),
		fileSize: v.number(),
		// Semantic metadata
		title: v.optional(v.string()),
		summary: v.optional(v.string()),
		extractedText: v.optional(v.string()),
		tags: v.optional(v.array(v.string())),
		autoTags: v.optional(v.array(v.string())),
		// Provenance
		sourceType: semanticFileSourceTypeValidator,
		sourceMessageId: v.optional(v.string()),
		uploadedBy: v.optional(v.string()),
		// Provenance: why/where this version was shared. JSON-stringified
		// { senderName?, excerpt?, threadSubject?, timestamp? } captured from the
		// surrounding conversation at upload time.
		uploadContext: v.optional(v.string()),
		// Relationships
		contactIds: v.optional(v.array(v.id('contacts'))),
		threadId: v.optional(v.id('conversationThreads')),
		// Versioning
		version: v.number(),
		previousVersionId: v.optional(v.id('semanticFiles')),
		// Human-readable diff vs the previous version (text-based files only),
		// e.g. "≈3 paragraphs changed". Computed by the processing pipeline.
		changeSummary: v.optional(v.string()),
		// Vector embedding for semantic search
		embedding: v.array(v.float64()),
		// Model that produced `embedding` (e.g., 'text-embedding-3-small'). Re-embed when this changes.
		embeddingModel: v.optional(v.string()),
		// When `embedding` was generated; used to schedule re-embedding on stale entries.
		embeddingGeneratedAt: v.optional(v.number()),
		// Embedding provenance and the staged-rebuild column (ADR-0073), as on
		// `knowledgeEntries`: an absent space is unknown and out of vector search.
		...embeddingProvenanceFields,
		...embeddingSecondarySlotFields,
		// Full-text search
		searchableText: v.optional(v.string()),
		// WHICH inbound route captured this file, set only by `captureAttachments`
		// (an upload or an agent-generated file leaves it absent). `sourceType`
		// alone cannot answer this: BOTH inbound routes write
		// `sourceType: 'email_attachment'`, so a retention horizon configured for
		// the shared inbox would otherwise also strip the file-library blobs of
		// personal-mailbox (Postbox) mail, which has its own permanent raw storage
		// and no horizon at all. The inbound retention sweep scans
		// `captureSource === 'team_inbox'` and nothing else.
		captureSource: v.optional(captureSourceValidator),
		// When the retention sweep released this file's bytes. Set exactly once,
		// by the sweep, together with clearing `storageId`. It is also the
		// equality component of `by_attachment_retention`, which is what makes
		// that sweep self-terminating: a released row falls out of the scanned
		// range instead of being re-examined on every tick.
		bytesReleasedAt: v.optional(v.number()),
		// Timestamps
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_created_at', ['createdAt'])
		.index('by_thread', ['threadId'])
		.index('by_attachment_retention', ['captureSource', 'bytesReleasedAt', 'createdAt'])
		.index('by_embedding_space', ['embeddingSpaceId', 'embeddingGeneratedAt'])
		.index('by_secondary_embedding_space', ['secondaryEmbeddingSpaceId'])
		// SEALED-AT-REST EXCEPTION (Sealed Mail E8b): as with knowledge entries,
		// `searchableText` (full-text) and `embedding` (vector) stay PLAINTEXT-DERIVED
		// so file search + semantic retrieval keep working — Convex indexes plaintext.
		// Documented, deliberate exception. See lib/atRestBodies.ts and
		// apps/docs/content/en/3.developer/21.sealed-mail-at-rest.md.
		.searchIndex('search_files', {
			searchField: 'searchableText',
			filterFields: [],
		})
		.vectorIndex('vector_files', {
			vectorField: 'embedding',
			dimensions: 1536,
			filterFields: ['embeddingSpaceId'],
		})
		.vectorIndex('vector_files_secondary', {
			vectorField: 'secondaryEmbedding',
			dimensions: 1536,
			filterFields: ['secondaryEmbeddingSpaceId'],
		}),

	// Semantic file ↔ Contact junction — an index-able mirror of
	// `semanticFiles.contactIds` (an array Convex can't index). One row per
	// (fileId, contactId); written/cleaned by the same mutations that set/clear
	// `contactIds` (syncFileContacts). `listByContact` queries `by_contact`
	// instead of scanning the newest 200 files and filtering the array in JS, so
	// it stays complete (no silent truncation past 200) and O(matches). Repointed
	// on contact merge (lib/contactMutations.ts) and torn down with the parent
	// file on delete / org-wipe. Mirrors `knowledgeEntryContacts`.
	semanticFileContacts: defineTable({
		fileId: v.id('semanticFiles'),
		contactId: v.id('contacts'),
	})
		.index('by_contact', ['contactId'])
		.index('by_file', ['fileId']),
};
