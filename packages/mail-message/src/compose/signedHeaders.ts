/**
 * The DKIM signed-header CONTRACT, split from `./dkim.ts` so a caller that only
 * needs the declaration — the Convex isolate-side marketing-compliance gate
 * asserts the one-click pair is covered — can import it without pulling the
 * signer's `node:crypto` into a runtime that has no Node builtins. The signer
 * re-exports it, so existing consumers (the MTA included) are unaffected.
 * No imports here, on purpose: this module must stay isolate-safe.
 */

/**
 * Headers we sign when present (relaxed/relaxed). Mirrors the RFC 4871 §5.5
 * default set, trimmed to the headers Owlat actually emits, plus the
 * List-Unsubscribe PAIR so one-click unsubscribe stays integrity-protected.
 *
 * `list-unsubscribe-post` is deliberately listed alongside `list-unsubscribe`:
 * RFC 8058 §5.2 requires BOTH headers under the same DKIM signature whose `d=`
 * aligns with From, or Gmail suppresses the one-click unsubscribe button
 * (the 2024 bulk-sender rule). Dropping the `-post` entry re-introduces that
 * regression.
 *
 * The RFC 9477 CFBL pair is here for the same class of reason: §3.1.4 says both
 * fields MUST appear in the `h=` tag of the signature whose `d=` matches the
 * CFBL address domain, and that "if the header field is not covered by the `h=`
 * tag, the Mailbox Provider SHALL NOT send a report message". Uncovered, the
 * advertised complaint address is both inert (no provider will use it) and
 * rewritable in transit (an intermediary could redirect complaints).
 */
export const SIGNED_HEADERS: readonly string[] = [
	'from',
	'sender',
	'reply-to',
	'subject',
	'date',
	'message-id',
	'to',
	'cc',
	'mime-version',
	'content-type',
	'content-transfer-encoding',
	'list-unsubscribe',
	'list-unsubscribe-post',
	'cfbl-address',
	'cfbl-feedback-id',
];
