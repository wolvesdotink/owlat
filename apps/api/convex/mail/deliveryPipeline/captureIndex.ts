/**
 * Inbound delivery pipeline — the I/O half of attachment capture: resolve the
 * sender's contact scope, charge the AI-ingest budget, and hand a stored part
 * to `semanticFiles.ingest`.
 *
 * Split out of `capture.ts` so the same steps run from an action (the team
 * inbox, capturing inline) and from a mutation (the personal mailbox, whose
 * capture is scheduled off the MTA webhook — see `deferredCapture.ts`). Both
 * ctx kinds carry `runQuery` and `runMutation`, and nothing here needs more.
 */

import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { extractEmail } from '../../lib/emailAddress';
import { hasTextExtraction } from '../../lib/fileExtraction';
import { logWarn } from '../../lib/runtimeLog';
import type { CaptureSource } from '../../lib/literalValidators';

/** The runtime surface scoping and ingest need — an action's or a mutation's. */
export type CaptureRunner = {
	runMutation: ActionCtx['runMutation'];
	runQuery: ActionCtx['runQuery'];
};

/**
 * Resolve the sender's contact scope and charge the AI-ingest budget for
 * `count` parts. `null` means the budget refused the batch.
 */
export async function scopeAndChargeBudget(
	ctx: CaptureRunner,
	input: { from: string; messageId: string; count: number }
): Promise<{ contactIds?: Id<'contacts'>[] } | null> {
	// Scope captured files to the sender's EXISTING contact (find-only). An
	// unresolvable sender leaves the file org-general. Resolved once per
	// message, not per part.
	const senderEmail = extractEmail(input.from);
	let senderContactIds: Id<'contacts'>[] | undefined;
	// Resolved HERE rather than taken from the caller even where the caller has
	// just upserted the contact: `getByEmailForTeam` is the lookup that ignores
	// GDPR gravestones, and an id handed in from outside would file an
	// attachment under an erased contact.
	if (senderEmail) {
		const contact = await ctx.runQuery(internal.contacts.contacts.getByEmailForTeam, {
			email: senderEmail,
		});
		if (contact) senderContactIds = [contact._id];
	}

	// Prefer the resolved contact id: it survives a sender rewriting their
	// display name, and it is the key the agent-pipeline gate already uses. The
	// already-lowercased address is the fallback for a sender with no contact (or
	// one erased under GDPR, which `getByEmailForTeam` reads as absent).
	// `||`, not `??`: `extractEmail` returns `''` for a From header with nothing
	// address-shaped in it, and an empty bucket key is not a key.
	const senderKey = senderContactIds?.[0] ?? (senderEmail || 'unknown');
	const { ok } = await ctx.runMutation(
		internal.knowledge.attachmentIngestBudget.consumeAttachmentIngestBudget,
		{
			senderKey,
			count: input.count,
		}
	);
	if (!ok) {
		// The bytes are NOT dropped: the message row, its attachment metadata and
		// the sealed raw `.eml` all exist, so the reader's download still works.
		// Only the indexing — and therefore the model spend — is skipped. A WARN,
		// not an error: this is the budget doing its job, on a route where a busy
		// inbox will trip it routinely.
		logWarn('[Attachment capture] AI ingest budget exhausted — bytes stored, indexing skipped', {
			senderKey,
			messageId: input.messageId,
			count: input.count,
		});
		return null;
	}
	return { contactIds: senderContactIds };
}

/** One cleared part whose bytes are already in storage. */
export type StoredPart = {
	storageId: Id<'_storage'>;
	filename: string;
	contentType: string;
	size: number;
};

export type IndexedPart = { indexed: boolean; namesOnly: boolean };

/** Hand one stored part to `semanticFiles.ingest`. */
export async function ingestStoredPart(
	ctx: CaptureRunner,
	part: StoredPart,
	meta: { messageId: string; captureSource: CaptureSource; contactIds?: Id<'contacts'>[] }
): Promise<IndexedPart> {
	// `ingest` re-runs the same file-type policy as `selectIngestible` and
	// deletes the blob if it disagrees.
	const fileId = await ctx.runMutation(internal.semanticFiles.ingest, {
		storageId: part.storageId,
		filename: part.filename,
		mimeType: part.contentType,
		fileSize: part.size,
		sourceType: 'email_attachment',
		captureSource: meta.captureSource,
		sourceMessageId: meta.messageId,
		contactIds: meta.contactIds,
	});
	if (!fileId) return { indexed: false, namesOnly: false };
	// Ingested, and the extractor will answer it with `[Word document: …]`.
	// Recorded so the reader is not shown a row that looks exactly like a
	// PDF the assistant read cover to cover.
	return { indexed: true, namesOnly: !hasTextExtraction(part.contentType, part.filename) };
}
