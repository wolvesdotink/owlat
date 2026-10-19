/**
 * Remote-image policy and the per-sender allowlist — the pure half.
 *
 * The reader loads remote images when a message opens (the `autoLoadImages`
 * preference, default on), except in suspicious mail, which always asks first
 * (see {@link isPostboxMessageSuspicious}). With the preference off, the reader
 * asks on every message, and a sender on the allowlist has its images loaded
 * on render instead. Three invariants are encoded here rather than in the
 * component, so they can be asserted without mounting a Convex-backed reader:
 *
 *   1. Tracking-pixel stripping is INDEPENDENT of the allowlist. Being trusted
 *      loads a sender's real images; it never un-strips their pixels. Only the
 *      per-message, never-persisted "Load everything" escalation does that.
 *   2. A sender can only be trusted when we actually resolved an address to key
 *      the grant on — a malformed `From` offers no "Always for…" affordance,
 *      because the grant would key on something no message can match.
 *   3. Suspicious mail never loads images on open, not even for a trusted
 *      sender: a forged From is exactly how it would borrow that trust.
 *
 * The banner state machine lives here too: the reader renders exactly one
 * banner state (see `PostboxImageBannerState`), and which one is a pure
 * function of the render's facts.
 */

import { deriveSenderRowMarker, senderRiskInputOf, type SenderAuthMessage } from './senderAuth';

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

/** What a message carries into the suspicious-mail check. */
export interface PostboxImageRiskMessage extends SenderAuthMessage {
	spamVerdict?: string;
}

/**
 * Mail whose images must not load on open: the spam filter flagged it, or the
 * sender looks forged (authentication failed or passed for another domain, or
 * the domain imitates one of your contacts' domains). The same signals as the
 * list's danger marker, so a message the list marks is never one the reader
 * quietly loads. A Reply-To on another domain alone does not count; it says
 * where a reply would go, not who sent the mail.
 */
export function isPostboxMessageSuspicious(message: PostboxImageRiskMessage): boolean {
	if (message.spamVerdict === 'spam') return true;
	return deriveSenderRowMarker(senderRiskInputOf(message)) !== null;
}

/**
 * The remote-image inputs a reader message hands its body, named as
 * PostboxMessageBody's props so the reader can bind the object as is.
 */
export interface PostboxBodyImageProps {
	/** The sender is on the mailbox allowlist. */
	senderImagesAllowed: boolean;
	/** The `autoLoadImages` preference. */
	autoLoadImages: boolean;
	/** {@link isPostboxMessageSuspicious} for this message. */
	suspicious: boolean;
}

export function postboxBodyImageProps(
	message: PostboxImageRiskMessage,
	input: { autoLoadImages: boolean; isSenderAllowed: boolean }
): PostboxBodyImageProps {
	return {
		senderImagesAllowed: input.isSenderAllowed,
		autoLoadImages: input.autoLoadImages,
		suspicious: isPostboxMessageSuspicious(message),
	};
}

/** Whether a message's remote images load as soon as it opens. */
export function postboxImagesLoadOnOpen(input: Partial<PostboxBodyImageProps>): boolean {
	if (input.suspicious) return false;
	return !!input.autoLoadImages || !!input.senderImagesAllowed;
}

/**
 * The one banner the reader shows above a message body.
 *
 *   - `blocked`         → remote images are still gated. Offers "Show once" and,
 *                         when the sender is keyable, "Always for {host}".
 *   - `suspicious`      → images are gated because the message looks suspicious.
 *                         Says so and offers "Show images" for this message
 *                         only; never "Always for…", which would hand a forged
 *                         sender the real one's trust.
 *   - `auto-allowed`    → images loaded because the sender is trusted. Says so,
 *                         says pixels are still stripped, and links to the
 *                         management list — a silent auto-load would be the
 *                         wrong kind of quiet.
 *   - `trackers-blocked`→ images were shown for this message only, and probable
 *                         tracking pixels are being withheld.
 *   - `unchecked`       → the body could not be checked safely, so images stay
 *                         blocked whatever was shown or trusted; only the
 *                         deliberate "Load everything" lifts that. It outranks
 *                         `auto-allowed` and the shown-once states, which would
 *                         otherwise claim images are loading.
 *   - `none`            → nothing to say.
 */
export type PostboxImageBannerState =
	| { kind: 'none' }
	| { kind: 'blocked'; trackerCount: number; canTrustSender: boolean }
	| { kind: 'suspicious'; trackerCount: number }
	| { kind: 'auto-allowed'; trackerCount: number }
	| { kind: 'trackers-blocked'; trackerCount: number }
	| { kind: 'unchecked' };

export function resolvePostboxImageBanner(input: {
	/** The sanitized body references at least one remote resource (img, srcset, CSS). */
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
	/** The body could not be inventoried; remote loads stay blocked. */
	inventoryFailed: boolean;
	/** {@link isPostboxMessageSuspicious}; absent reads as not suspicious. */
	isSuspicious?: boolean;
}): PostboxImageBannerState {
	if (!input.hasRemoteImages) return { kind: 'none' };
	if (input.inventoryFailed && !input.loadEverything) return { kind: 'unchecked' };
	if (!input.showImages) {
		if (input.isSuspicious) return { kind: 'suspicious', trackerCount: input.trackerCount };
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
