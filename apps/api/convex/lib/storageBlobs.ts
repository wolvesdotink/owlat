/**
 * Deleting stored bytes on a path that must not fail because of them.
 *
 * Four modules had reached the same conclusion independently — the GDPR
 * erasure cascade, the dev reset, the inbound retention sweep and the inbound
 * ingest's staged-blob drop — and each spelled out its own try/delete/catch.
 * The POLICY in all four is identical and is the part worth keeping in one
 * place: "already gone" is the ordinary case (a prior partial run, a released
 * blob whose row still names it, a manual purge), a transient storage failure
 * must not abort a cascade that is otherwise complete, and an orphan nothing
 * logs is an orphan nobody ever finds — the sweeps walk ROWS, not storage.
 */

import type { Id } from '../_generated/dataModel';
import { logError } from './runtimeLog';

/** Just the part of a Convex ctx this needs — mutation and action ctx both fit. */
export type BlobStorage = { delete: (storageId: Id<'_storage'>) => Promise<void> };

/**
 * Delete a blob, or log why it could not be deleted. Never throws.
 *
 * `logTag` names the caller in the log line ('[contacts] erasure', '[dev
 * reset]', …) and `context` carries whatever identifies the row it belonged to,
 * because the storage id alone is not something an operator can look up once
 * the row that named it is gone.
 */
export async function deleteBlobQuietly(
	storage: BlobStorage,
	storageId: Id<'_storage'>,
	logTag: string,
	context?: Record<string, unknown>
): Promise<void> {
	try {
		await storage.delete(storageId);
	} catch (err) {
		logError(`${logTag} blob delete failed`, { storageId, ...context, err });
	}
}
