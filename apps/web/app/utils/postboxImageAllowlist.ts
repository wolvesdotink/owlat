/**
 * Per-sender remote-image allowlist — the pure half.
 *
 * The reader blocks remote images by default and asks again on every issue of
 * the same newsletter. A sender on this list has its images loaded on render
 * instead. Two invariants are encoded here rather than in the component, so
 * they can be asserted without mounting a Convex-backed reader:
 *
 *   1. Tracking-pixel stripping is INDEPENDENT of the allowlist. Being trusted
 *      loads a sender's real images; it never un-strips their pixels. Only the
 *      per-message, never-persisted "Load everything" escalation does that.
 *   2. A sender can only be trusted when we actually resolved an address to key
 *      the grant on — a malformed `From` offers no "Always for…" affordance,
 *      because the grant would key on something no message can match.
 *
 * The banner state machine lives here too: the reader renders exactly one of
 * four states, and which one is a pure function of the render's facts.
 */

/** A stored grant, as the settings list and the reader both consume it. */
export interface PostboxImageAllowlistEntry {
	senderEmail: string;
}

/**
 * Canonical sender key: the bare, lowercased address. Mirrors the backend's
 * `normalizeEmail` and the lowercased `mailMessages.fromAddress` written at
 * ingest, so a grant made from the reader matches future mail. `null` when no
 * `local@domain` can be read out of the header value.
 */
export function postboxSenderKey(fromAddress: string | undefined | null): string | null {
	if (!fromAddress) return null;
	const trimmed = fromAddress.trim();
	// Accept `a@b`, `<a@b>` and `Name <a@b>` — the shapes a From header takes.
	const match = trimmed.match(/([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)/);
	if (!match?.[1]) return null;
	return match[1].toLowerCase();
}

/**
 * What the "Always for…" affordance names. The domain reads as the publisher
 * ("Always for stratechery.com") where the full address reads as plumbing, so
 * the domain wins when there is one; the address is the honest fallback.
 */
export function postboxSenderTrustLabel(fromAddress: string | undefined | null): string | null {
	const key = postboxSenderKey(fromAddress);
	if (!key) return null;
	const domain = key.slice(key.lastIndexOf('@') + 1);
	return domain || key;
}

/** Is this sender on the mailbox's allowlist? */
export function isPostboxSenderImageAllowed(
	entries: readonly PostboxImageAllowlistEntry[] | undefined | null,
	fromAddress: string | undefined | null
): boolean {
	const key = postboxSenderKey(fromAddress);
	if (!key || !entries) return false;
	return entries.some((entry) => entry.senderEmail.toLowerCase() === key);
}

/**
 * The one banner the reader shows above a message body.
 *
 *   - `blocked`         → remote images are still gated. Offers "Show once" and,
 *                         when the sender is keyable, "Always for {host}".
 *   - `auto-allowed`    → images loaded because the sender is trusted. Says so,
 *                         says pixels are still stripped, and links to the
 *                         management list — a silent auto-load would be the
 *                         wrong kind of quiet.
 *   - `trackers-blocked`→ images were shown for this message only, and probable
 *                         tracking pixels are being withheld.
 *   - `none`            → nothing to say.
 */
export type PostboxImageBannerState =
	| { kind: 'none' }
	| { kind: 'blocked'; trackerCount: number; canTrustSender: boolean }
	| { kind: 'auto-allowed'; trackerCount: number }
	| { kind: 'trackers-blocked'; trackerCount: number };

export function resolvePostboxImageBanner(input: {
	/** The sanitized body contains at least one remote `<img>`. */
	hasRemoteImages: boolean;
	/** Images are currently being rendered. */
	showImages: boolean;
	/** The user escalated past pixel stripping for this message. */
	loadEverything: boolean;
	/** The sender is on the mailbox allowlist. */
	isSenderAllowed: boolean;
	/** A canonical sender key could be derived from the From header. */
	hasSenderKey: boolean;
	trackerCount: number;
}): PostboxImageBannerState {
	if (!input.hasRemoteImages) return { kind: 'none' };
	if (!input.showImages) {
		return {
			kind: 'blocked',
			trackerCount: input.trackerCount,
			canTrustSender: input.hasSenderKey,
		};
	}
	// Everything below is "images are showing". Once the user has escalated to
	// loading everything there is no protection left to report, so say nothing.
	if (input.loadEverything) return { kind: 'none' };
	if (input.isSenderAllowed) return { kind: 'auto-allowed', trackerCount: input.trackerCount };
	if (input.trackerCount > 0) return { kind: 'trackers-blocked', trackerCount: input.trackerCount };
	return { kind: 'none' };
}
