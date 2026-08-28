/**
 * Attachment share links (plan idea 10) — the vocabulary shared by the Convex
 * backend (table rows, the serving route, the expiry sweep) and the web client
 * (the composer's "Share as link instead", the settings management list).
 *
 * The point of the feature: a file too big for the wire becomes a URL in the
 * body instead of a part that bounces. That makes the SAME bytes reachable to
 * anyone holding the URL, so the rules that decide whether a link still resolves
 * cannot live on one side of the wire only — a client that renders "expires in 3
 * days" while the server serves it forever is worse than no expiry at all. Every
 * predicate below is pure and is the one both planes call.
 *
 * Three states, and the order matters: a link revoked BEFORE it expired is
 * `revoked`, not `expired`. The owner pressed a button; the list must say so,
 * and the serving route must not report an expiry the owner never waited for.
 */

/** Route prefix the token-serving HTTP action is registered under. */
export const ATTACHMENT_SHARE_PATH = '/attachment-share/';

/**
 * Token length in characters. The token IS the access control for an
 * `anyone`-scoped link, so it is generated from the 64-symbol URL alphabet:
 * 32 characters is 192 bits, far past anything a guessing attack reaches even
 * without the rate limit the route also applies.
 */
export const ATTACHMENT_SHARE_TOKEN_LENGTH = 32;

/** The URL-safe alphabet a share token is drawn from (nanoid's default). */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Structural check on a token from an untrusted URL. Cheap pre-filter so a
 * malformed path never becomes a database read; it asserts nothing about
 * whether the token exists.
 */
export function isAttachmentShareToken(token: string | null | undefined): boolean {
	return (
		typeof token === 'string' &&
		token.length === ATTACHMENT_SHARE_TOKEN_LENGTH &&
		TOKEN_PATTERN.test(token)
	);
}

/**
 * How long a new link stays valid, in days. A CLOSED set for the same reason the
 * trash horizon is one: the control renders as a handful of choices, and an
 * arbitrary lifetime invites links that outlive the reason they existed.
 */
export const ATTACHMENT_SHARE_EXPIRY_DAY_CHOICES = [7, 14, 30, 90] as const;
export type AttachmentShareExpiryDays = (typeof ATTACHMENT_SHARE_EXPIRY_DAY_CHOICES)[number];

/**
 * Lifetime applied when the owner has never chosen one. Two weeks is long enough
 * for a recipient who reads mail on Monday and acts on it the next weekend, and
 * short enough that a forgotten link is not a permanent open door.
 */
export const ATTACHMENT_SHARE_DEFAULT_EXPIRY_DAYS: AttachmentShareExpiryDays = 14;

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Narrow an unvalidated preference to a supported lifetime (absent ⇒ default). */
export function resolveAttachmentShareExpiryDays(
	value: number | null | undefined
): AttachmentShareExpiryDays {
	return ATTACHMENT_SHARE_EXPIRY_DAY_CHOICES.includes(value as AttachmentShareExpiryDays)
		? (value as AttachmentShareExpiryDays)
		: ATTACHMENT_SHARE_DEFAULT_EXPIRY_DAYS;
}

/** Absolute expiry for a link created at `createdAt` with `days` of life. */
export function attachmentShareExpiryAt(createdAt: number, days: number): number {
	return createdAt + resolveAttachmentShareExpiryDays(days) * DAY_MS;
}

/**
 * Who may fetch the bytes.
 *
 *  - `anyone`   — the token alone opens it. This is what a link in an outgoing
 *                 message HAS to be: the recipient is on the other side of the
 *                 internet with no account here, and a link they cannot open is
 *                 not a share, it is a 403 with extra steps.
 *  - `mailbox`  — the public route refuses the token outright; the bytes are
 *                 only reachable from inside the app, through the authorized
 *                 sealed-blob proxy the mailbox's own attachments already use.
 *                 Narrowing an existing link to this is a PARTIAL revoke: the
 *                 external link dies, the file stays.
 */
export type AttachmentShareScope = 'anyone' | 'mailbox';

export const ATTACHMENT_SHARE_SCOPES: readonly AttachmentShareScope[] = ['anyone', 'mailbox'];

export function isAttachmentShareScope(value: unknown): value is AttachmentShareScope {
	return value === 'anyone' || value === 'mailbox';
}

/** Lifecycle state of one share row, as both planes report it. */
export type AttachmentShareState = 'live' | 'revoked' | 'expired';

/** The fields any state decision reads — a projection both planes can build. */
export interface AttachmentShareLifecycle {
	expiresAt: number;
	revokedAt?: number | null;
}

/**
 * Resolve a row's state at `now`. Revocation wins over expiry: it is the
 * stronger, deliberate fact, and reporting "expired" for a link someone killed
 * on purpose misdescribes what happened.
 */
export function attachmentShareState(
	row: AttachmentShareLifecycle,
	now: number
): AttachmentShareState {
	if (row.revokedAt != null) return 'revoked';
	return row.expiresAt <= now ? 'expired' : 'live';
}

/** Milliseconds until a live link lapses; `0` once it is no longer live. */
export function attachmentShareRemainingMs(row: AttachmentShareLifecycle, now: number): number {
	return attachmentShareState(row, now) === 'live' ? Math.max(0, row.expiresAt - now) : 0;
}

/** The fields the public serving route gates on. */
export interface AttachmentShareServable extends AttachmentShareLifecycle {
	scope: AttachmentShareScope;
	/** Absent once the bytes have been reclaimed (revoked or swept). */
	hasBytes: boolean;
}

/**
 * Whether the PUBLIC token route may stream this row's bytes. Every reason to
 * refuse is folded here so the route cannot forget one: the link must be live,
 * scoped to `anyone`, and still have bytes behind it.
 */
export function isAttachmentShareServable(row: AttachmentShareServable, now: number): boolean {
	return row.hasBytes && row.scope === 'anyone' && attachmentShareState(row, now) === 'live';
}

/**
 * How long a dead row lingers before the sweep deletes it outright. The BYTES go
 * as soon as the link stops being live; the row survives so the management list
 * can still explain what happened to a link a recipient is asking about.
 */
export const ATTACHMENT_SHARE_PURGE_GRACE_MS = 30 * DAY_MS;

/** Whether a dead row is old enough for the sweep to delete the record itself. */
export function isAttachmentSharePurgeable(
	row: AttachmentShareLifecycle & { hasBytes: boolean },
	now: number
): boolean {
	if (row.hasBytes) return false;
	const deadAt = row.revokedAt ?? row.expiresAt;
	return now - deadAt >= ATTACHMENT_SHARE_PURGE_GRACE_MS;
}

/** Public URL for a token, given the deployment's HTTP-actions site origin. */
export function attachmentShareUrl(siteUrl: string, token: string): string {
	return `${siteUrl.replace(/\/+$/, '')}${ATTACHMENT_SHARE_PATH}${encodeURIComponent(token)}`;
}
