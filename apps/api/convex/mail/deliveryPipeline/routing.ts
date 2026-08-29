/**
 * Personal-mail delivery pipeline — the pure routing decisions.
 *
 * Three side-effect-free steps `mail/delivery.ts::deliverToMailbox` runs
 * between the dedup check and the row insert: fill in a missing spam verdict,
 * reduce the user's filter matches to a delivery decision, and settle the
 * DMARC/ARC verdict that picks Inbox vs Spam. They read no `ctx` — the caller
 * loads the filter rows and the instance settings and hands them in — so each
 * is directly unit-testable and the mutation keeps a single readable flow.
 */

import { DEFAULT_TRUSTED_ARC_FORWARDERS, shouldArcOverrideDmarc } from '@owlat/shared/arcTrust';
import { scanContent } from '@owlat/email-scanner';
import { evaluateFilters } from '../filters';
import type { Doc, Id } from '../../_generated/dataModel';

/**
 * Content/spam scan for personal mailboxes.
 *
 * The MTA only runs @owlat/email-scanner on the OUTBOUND path, so mail
 * delivered into a hosted (Postbox) mailbox arrives with no spam/phishing
 * scoring at all. Score it here when the inbound pipeline did not already
 * supply a verdict, so personal inboxes get the same keyword / phishing-URL /
 * caps-abuse scoring outbound mail does. An MTA-supplied verdict (when present)
 * always wins — we only fill the gap.
 */
export function resolveSpamVerdict(input: {
	subject: string;
	bodyHtmlInline?: string;
	bodyTextInline?: string;
	from: string;
	replyTo?: string;
	spamScore?: number;
	spamVerdict?: 'ham' | 'spam' | 'quarantine';
}): { spamScore?: number; spamVerdict?: 'ham' | 'spam' | 'quarantine' } {
	if (input.spamScore != null || input.spamVerdict != null) {
		return { spamScore: input.spamScore, spamVerdict: input.spamVerdict };
	}
	const scan = scanContent(input.subject, input.bodyHtmlInline ?? input.bodyTextInline ?? '', {
		from: input.from,
		replyTo: input.replyTo,
	});
	return {
		spamScore: scan.score,
		// `blocked` (score >= 40) is high enough confidence to route to Spam;
		// `suspicious`/`clean` stay in the inbox but keep their numeric score.
		spamVerdict: scan.level === 'blocked' ? 'spam' : 'ham',
	};
}

/**
 * Reduce the user's matching filter rules to a delivery decision: an override
 * folder, flags, labels, an inbox section, filter-level forward targets, and the
 * two short-circuits (`discard` drops the message entirely; `delete` routes it
 * to Trash).
 */
export function resolveFilterOutcome(
	filters: Doc<'mailFilters'>[],
	message: Parameters<typeof evaluateFilters>[1]
): {
	isDiscarded: boolean;
	isTrashed: boolean;
	folderId?: Id<'mailFolders'>;
	labelIds: Id<'mailLabels'>[];
	flagSeen: boolean;
	flagFlagged: boolean;
	pinnedSection?: string;
	filterForwardTo: string[];
} {
	const evalResult = evaluateFilters(filters, message);
	const moveAction = evalResult.actions.find((a) => a.type === 'moveToFolder');
	// A message has ONE section — the first `pinToSection` in priority order wins,
	// exactly like `moveToFolder`. Two rules that both claim a message are a
	// precedence question the user already answers by ordering their filters.
	const pinAction = evalResult.actions.find(
		(a) => a.type === 'pinToSection' && (a.sectionName ?? '').length > 0
	);
	return {
		pinnedSection: pinAction?.sectionName,
		// `discard` short-circuits — the caller drops the message entirely (and
		// its staged storage blob) without writing it anywhere.
		isDiscarded: evalResult.actions.some((a) => a.type === 'discard'),
		isTrashed: evalResult.actions.some((a) => a.type === 'delete'),
		folderId: moveAction?.folderId,
		labelIds: evalResult.actions
			.filter((a) => a.type === 'addLabel')
			.map((a) => a.labelId)
			.filter((id): id is Id<'mailLabels'> => !!id),
		flagSeen: evalResult.actions.some((a) => a.type === 'markRead'),
		flagFlagged: evalResult.actions.some((a) => a.type === 'markFlagged'),
		filterForwardTo: evalResult.actions
			.filter((a) => a.type === 'forward' && a.forwardTo)
			.map((a) => a.forwardTo as string),
	};
}

/**
 * Settle the inbound DMARC verdict, including the ARC rescue.
 *
 * ARC rescue (RFC 8617, Sealed Mail A5): a mailing-list / forwarder that broke
 * the author's DKIM makes DMARC fail even for legitimate mail. When a TRUSTED
 * forwarder sealed a VALID chain (`cv=pass`) attesting the original passed,
 * honour that attestation — suppress the Spam routing and record
 * `dmarcOverride: 'arc'` + the sealer so the reader's badge can say "verified
 * via forwarder". Trust is decided HERE against the operator's editable
 * allow-list (unset ⇒ the seeded defaults); an explicit `[]` disables the
 * override. The predicate is shared with the MTA so the two sides never fork on
 * what "trusted rescue" means. The override only APPLIES to an actual DMARC
 * fail — that is the only verdict there is anything to rescue. A message that
 * passed DMARC on its own (or where DMARC was not evaluated) keeps its own
 * verdict, so a direct-pass forward is never mislabelled "verified via
 * forwarder".
 *
 * A DMARC fail (RFC 7489) routes to Spam only when the From-domain owner
 * published an enforcing policy (`quarantine`/`reject`). A `p=none` fail is
 * monitor-only — record the verdict but do not move the message. A permanent
 * DMARC evaluation error is independently fail-closed: malformed/ambiguous From
 * identifiers have no trustworthy domain from which to obtain a policy and must
 * not land in Inbox merely because policy lookup is impossible.
 */
export function resolveDmarcRouting(
	auth: {
		dmarcResult?: string;
		dmarcPolicy?: string;
		arcCv?: string;
		arcSealerDomain?: string;
		arcAttestsOriginalPass?: boolean;
	},
	trustedForwarders: string[] | undefined
): { dmarcOverride?: string; arcSealer?: string; isDmarcQuarantine: boolean } {
	const forwarders = trustedForwarders ?? DEFAULT_TRUSTED_ARC_FORWARDERS;
	const isArcRescued =
		auth.dmarcResult === 'fail' &&
		shouldArcOverrideDmarc(
			{
				arcCv: auth.arcCv,
				arcSealerDomain: auth.arcSealerDomain,
				arcAttestsOriginalPass: auth.arcAttestsOriginalPass,
			},
			forwarders
		);
	return {
		dmarcOverride: isArcRescued ? 'arc' : undefined,
		arcSealer: isArcRescued ? auth.arcSealerDomain : undefined,
		isDmarcQuarantine:
			auth.dmarcResult === 'permerror' ||
			(!isArcRescued &&
				auth.dmarcResult === 'fail' &&
				(auth.dmarcPolicy === 'quarantine' || auth.dmarcPolicy === 'reject')),
	};
}
