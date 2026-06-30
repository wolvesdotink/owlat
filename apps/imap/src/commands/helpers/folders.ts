/**
 * Folder lookups shared across LIST, SELECT, STATUS, COPY, MOVE,
 * APPEND. All of them need "given a mailbox-name string, find the
 * Convex folder row" — including the case-insensitive `INBOX` alias
 * fallback to the role.
 */

import type { ConvexClient } from '../../convex.js';
import { fn } from '../../convex.js';

export interface FolderRow {
	_id: string;
	name: string;
	role?: string;
	subscribed?: boolean;
	uidValidity?: number;
	uidNext?: number;
	highestModseq?: number;
	totalCount?: number;
	unseenCount?: number;
}

/** Untyped wrapper around `mailImap:listFolders`. */
export async function listFolders(
	convex: ConvexClient,
	mailboxId: string,
): Promise<FolderRow[]> {
	return (await convex.query(fn.listFolders as never, {
		mailboxId,
	} as never)) as FolderRow[];
}

/**
 * Resolve a client-supplied mailbox name. Case-insensitive match by
 * name; `INBOX` (any case) also falls back to whichever folder has
 * `role: 'inbox'`. Returns null when no match exists.
 */
export async function resolveFolderByName(
	convex: ConvexClient,
	mailboxId: string,
	name: string,
): Promise<FolderRow | null> {
	const folders = await listFolders(convex, mailboxId);
	const lower = name.toLowerCase();
	const direct = folders.find((f) => f.name.toLowerCase() === lower);
	if (direct) return direct;
	if (lower === 'inbox') {
		return folders.find((f) => f.role === 'inbox') ?? null;
	}
	return null;
}
