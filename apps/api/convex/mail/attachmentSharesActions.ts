'use node';

/**
 * Attachment share links (plan idea 10) — the CREATE half.
 *
 * An action, and it has to be, for one reason: a file only becomes shareable
 * after the malware scan. That is the same MTA/ClamAV endpoint the outbound
 * send path calls (`mail/outbound/build.ts`), it is a `fetch`, and a `fetch`
 * cannot happen in a mutation. Sharing must not be the side door that lets a
 * file this instance would refuse to SEND reach the internet anyway — and a
 * share link is arguably worse than an attachment, because it survives the
 * message and can be forwarded to people who never received it.
 *
 * The scan POLICY here matches the outbound send exactly, including its
 * fail-open: a CONFIRMED-infected verdict refuses, and everything else
 * (scanner absent, unreachable, HTTP error) proceeds — because a ClamAV outage
 * must not wedge the composer, and because refusing on an outage would train
 * people to reattach the 40 MB file and watch it bounce instead. Which of the
 * two outcomes opened the door is recorded on the row (`scanVerdict`), so an
 * operator can tell a scanned share from an unscanned one after the fact.
 *
 * Ordering is deliberate: authorize, then read, then scan, THEN write. Nothing
 * is detached from the draft until the bytes have cleared, so a refused share
 * leaves the composer exactly as it was and the user can simply remove the file
 * themselves.
 */

import { v } from 'convex/values';
import { nanoid } from 'nanoid';
import { ATTACHMENT_SHARE_TOKEN_LENGTH, attachmentShareUrl } from '@owlat/shared/attachmentShares';
import { internal } from '../_generated/api';
import { authedAction } from '../lib/authedFunctions';
import { getOptional } from '../lib/env';
import { throwForbidden, throwInvalidState } from '../_utils/errors';
import { getMtaConfig, scanAttachmentBytes } from './mtaClient';

/** What the composer gets back: either a usable link, or why there is none. */
export type ShareDraftAttachmentResult =
	| {
			ok: true;
			shareId: string;
			url: string;
			filename: string;
			size: number;
			expiresAt: number;
			/** Which scan outcome allowed it, so the UI can stay honest. */
			scanVerdict: 'clean' | 'skipped';
	  }
	| { ok: false; reason: 'infected'; filename: string; detail: string };

/**
 * Turn one committed draft attachment into a share link.
 *
 * Returns a structured refusal rather than throwing on the malware verdict: the
 * composer has to say "this file is infected and was not shared" next to the
 * chip, and an error envelope with a generic operation message cannot carry
 * that. Every OTHER failure (no draft, no access, no site URL) does throw,
 * because those are bugs or misconfiguration, not something to render.
 */
// authz: mailbox access via requireMailboxAccess inside `prepareShare` and
// again inside `createShare` (separate transactions, so both re-check); org
// membership via authedAction.
export const shareDraftAttachment = authedAction({
	args: {
		draftId: v.id('mailDrafts'),
		storageId: v.id('_storage'),
	},
	handler: async (ctx, args): Promise<ShareDraftAttachmentResult> => {
		// A share URL nobody can resolve is not a share. Fail before the scan
		// rather than detaching a file and handing back a broken link.
		const siteUrl = getOptional('CONVEX_SITE_URL');
		if (!siteUrl) {
			throwInvalidState('Share links need CONVEX_SITE_URL to be configured');
		}

		const prep = await ctx.runQuery(internal.mail.attachmentShares.prepareShare, {
			draftId: args.draftId,
			storageId: args.storageId,
		});
		if (!prep) throwForbidden('Attachment not accessible');

		const blob = await ctx.storage.get(args.storageId);
		if (!blob) throwInvalidState('The attachment file is no longer stored');
		const bytes = Buffer.from(await blob.arrayBuffer());

		// Same client, same fail-open contract as the outbound send: only a
		// CONFIRMED verdict gates; 'skipped' proceeds and is already surfaced to
		// the operator by `scannerHealth.warnScanSkipped` inside the client.
		const verdict = await scanAttachmentBytes(getMtaConfig(), prep.filename, bytes);
		if (verdict.kind === 'infected') {
			return {
				ok: false,
				reason: 'infected',
				filename: prep.filename,
				detail: verdict.reason,
			};
		}

		const created = await ctx.runMutation(internal.mail.attachmentShares.createShare, {
			draftId: args.draftId,
			storageId: args.storageId,
			token: nanoid(ATTACHMENT_SHARE_TOKEN_LENGTH),
			expiryDays: prep.expiryDays,
			scanVerdict: verdict.kind,
		});

		return {
			ok: true,
			shareId: created.shareId,
			url: attachmentShareUrl(siteUrl, created.token),
			filename: created.filename,
			size: created.size,
			expiresAt: created.expiresAt,
			scanVerdict: verdict.kind,
		};
	},
});
