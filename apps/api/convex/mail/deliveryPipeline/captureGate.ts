/**
 * L6, attachment gates (AI routing plan): behind the routing policy's
 * `attachmentGates` switch (`off` by default, which is today's behaviour),
 * attachment capture leaves out mail in Spam, mail the MTA called spam or
 * quarantine, and newsletters and automated mail. Their files are summarized,
 * embedded and extracted into knowledge today.
 *
 * The bytes still arrive, list and download; only the capture into the file
 * library (and from there into retrieval and knowledge) is skipped. The skip
 * comes back as the capture outcome (`spam` / `automated`), which the Team
 * Inbox route records on the row (`attachmentIndexing`). The Postbox route
 * records no capture outcome for any reason today (see the notes file).
 */

import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import {
	headerEvidenceFromMap,
	isAutomatedForAttachments,
	type HeaderEvidence,
} from '../../lib/mailEvidence';
import { logWarn } from '../../lib/runtimeLog';

/** Folder roles whose mail is never captured while the gate is on. */
const SPAM_ROLES: ReadonlySet<string> = new Set(['spam', 'junk']);

export interface AttachmentGateSignals {
	/** The folder the message was delivered into (Postbox only). */
	folderRole?: string;
	/** The MTA's spam verdict. */
	spamVerdict?: 'ham' | 'spam' | 'quarantine';
	headers: HeaderEvidence;
}

export type AttachmentGateSkip = 'spam' | 'automated';

/** Which gate, if any, keeps this message's attachments out. Pure. */
export function attachmentGateSkip(signals: AttachmentGateSignals): AttachmentGateSkip | null {
	if (signals.folderRole !== undefined && SPAM_ROLES.has(signals.folderRole)) return 'spam';
	if (signals.spamVerdict === 'spam' || signals.spamVerdict === 'quarantine') return 'spam';
	if (isAutomatedForAttachments(signals.headers)) return 'automated';
	return null;
}

/**
 * The gate for one message, or null while the switch is off. An unreadable
 * policy reads as the default (off), which captures as before.
 */
export async function resolveAttachmentGate(
	ctx: Pick<ActionCtx, 'runQuery'>,
	signals: AttachmentGateSignals
): Promise<AttachmentGateSkip | null> {
	try {
		const policy = await ctx.runQuery(internal.aiRouting.policy.getResolved, {});
		if (policy.attachmentGates !== 'enforce') return null;
	} catch (err) {
		logWarn('[Attachment capture] routing policy unreadable, gates off', { err });
		return null;
	}
	return attachmentGateSkip(signals);
}

/** What the Postbox delivery mutation settled about where the message went. */
export interface SettledRouting {
	folderRole?: string;
	spamVerdict?: 'ham' | 'spam' | 'quarantine';
}

/**
 * The gate signals of a Postbox (hosted MX) delivery: the folder and verdict
 * the mutation routed on, and the headers read at ingest. Pure.
 */
export function mailboxGateSignals(
	routing: SettledRouting,
	ingest: { antiLoopHeaders: Record<string, string>; unsubscribe?: unknown }
): AttachmentGateSignals {
	return {
		...(routing.folderRole !== undefined ? { folderRole: routing.folderRole } : {}),
		...(routing.spamVerdict !== undefined ? { spamVerdict: routing.spamVerdict } : {}),
		headers: headerEvidenceFromMap(ingest.antiLoopHeaders, {
			hasListUnsubscribe: ingest.unsubscribe !== undefined,
		}),
	};
}
