/**
 * Convex client wrapper used by the IMAP server.
 *
 * We use the HTTP transport so each connection can run its own client
 * with admin auth. For IDLE we also support a long-lived subscription
 * via the websocket client, but P4 (read-only) only needs HTTP.
 */

import { createAdminConvexClient } from '@owlat/shared';
import type { EndpointResult } from '@owlat/worker-protocol';
import {
	createCheckedClient,
	workerReferences,
	type CheckedConvexClient,
	type ConvexTransport,
} from '@owlat/worker-protocol/client';
import {
	IMAP_ENDPOINTS,
	type fetchChangedEnvelopes,
	type folderMembershipPage,
	type listFolders,
	type reportServer,
	type resolveMessageIdsByUid,
} from '@owlat/worker-protocol/imap';
import { ConvexHttpClient } from 'convex/browser';
import type { ImapConfig } from './config.js';

/**
 * The client every command calls Convex through: `ConvexHttpClient`'s surface,
 * with each answer checked against the IMAP wire contract
 * (`@owlat/worker-protocol/imap`) before any command reads it.
 */
export type ConvexClient = CheckedConvexClient;

export function createConvexClient(config: ImapConfig): ConvexClient {
	return checkedConvexClient(
		createAdminConvexClient(ConvexHttpClient, config.convexUrl, config.convexAdminKey)
	);
}

/** The IMAP contract's checks over any transport: what `createConvexClient` ships. */
export function checkedConvexClient(transport: ConvexTransport): ConvexClient {
	return createCheckedClient(transport, IMAP_ENDPOINTS);
}

// ── Wire shapes ─────────────────────────────────────────────────────────────
// What the `mail/*` functions below answer with, derived from the contract.
// Ids travel as plain strings: this workspace does not import apps/api's
// generated `_generated/api.d.ts` (that would couple the workspaces).

/** One LIST row. */
export type FolderRow = EndpointResult<typeof listFolders>[number];

/** A folder's membership read (`mail/imap/fetch:folderMembershipPage`). */
export type MembershipPage = EndpointResult<typeof folderMembershipPage>;

/** One page of `{ _id, uid, modseq }` inside a UID window. */
export type MessageIdPage = EndpointResult<typeof resolveMessageIdsByUid>;

/** One cursor page of the rows whose modseq moved past a baseline. */
export type ChangedEnvelopePage = EndpointResult<typeof fetchChangedEnvelopes>;

/** The wire-version handshake (`mail/imap/serverRegistry:report`). */
export type ImapServerReportResult = EndpointResult<typeof reportServer>;

/**
 * Typed references to the internal Convex functions the IMAP server calls,
 * built from the IMAP wire contract: its paths, kinds, argument and result
 * types all come from `@owlat/worker-protocol/imap`, the same declarations
 * apps/api registers as each function's `args` and `returns`. The convexRefs
 * test checks each path and kind against the Convex source.
 */
export const fn = workerReferences(IMAP_ENDPOINTS);
