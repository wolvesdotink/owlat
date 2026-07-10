/**
 * Add-a-campaign-sender advisory: map a from-address's sending-domain
 * verification status to the inline hint shown in the "Add sender" modal, and to
 * whether the address may be added at all.
 *
 * The curated-sender write path (`campaigns/senders.ts create`) hard-rejects any
 * address whose domain is not verified — a campaign sender must never sit on an
 * unverified domain, or it would punch a hole in the send-time floor. This util
 * mirrors that rule in the UI so the user learns *why* the button is disabled
 * before they submit, rather than eating a backend error. Same advisory shape the
 * campaign wizard's From-Email field uses (`components/campaigns/steps/SetupStep`).
 *
 * Pure and framework-free so it is unit-tested directly.
 */

/**
 * Structural subset of the backend's `EmailDomainVerificationStatus`
 * (`convex/domains/domains.ts`) — only the fields this advisory reads. Declared
 * locally so the util (and its test) stay free of Convex generated types.
 */
export interface SenderDomainStatus {
	domain: string;
	exists: boolean;
	verified: boolean;
	stale: boolean;
}

export type SenderVerificationTone = 'neutral' | 'success' | 'warning';

export interface SenderVerification {
	tone: SenderVerificationTone;
	message: string;
	/** Whether the address may be added — false blocks the modal's submit. */
	canAdd: boolean;
	/** True when the copy should offer a link to Settings → Domains. */
	showDomainsLink: boolean;
}

/**
 * Advisory for the "Add sender" address field.
 *
 * - No address / malformed → neutral prompt, cannot add yet.
 * - Check failed (query error/timeout) → warning, retry hint, cannot add.
 * - Domain not registered → warning, link to Domains, cannot add.
 * - Domain registered but unverified → warning, link to Domains, cannot add.
 * - Domain verified → success, can add. Staleness is ignored here: a verified
 *   domain is enough to curate a sender, so it is not surfaced in this advisory.
 */
export function mapSenderVerification(
	status: SenderDomainStatus | null | undefined,
	hasValidEmail: boolean,
	checkFailed = false
): SenderVerification {
	if (!hasValidEmail) {
		return {
			tone: 'neutral',
			message: 'Enter an address on one of your verified sending domains.',
			canAdd: false,
			showDomainsLink: false,
		};
	}
	if (checkFailed) {
		return {
			tone: 'warning',
			message: "Couldn't check this domain — clear the field and try again.",
			canAdd: false,
			showDomainsLink: false,
		};
	}
	if (!status) {
		return {
			tone: 'neutral',
			message: 'Checking this domain…',
			canAdd: false,
			showDomainsLink: false,
		};
	}
	if (!status.exists) {
		return {
			tone: 'warning',
			message: `"${status.domain}" isn't set up for sending yet. Add and verify it before using it as a campaign sender.`,
			canAdd: false,
			showDomainsLink: true,
		};
	}
	if (!status.verified) {
		return {
			tone: 'warning',
			message: `"${status.domain}" isn't verified yet. Finish DNS verification before using it as a campaign sender.`,
			canAdd: false,
			showDomainsLink: true,
		};
	}
	return {
		tone: 'success',
		message: `"${status.domain}" is verified — you can add this sender.`,
		canAdd: true,
		showDomainsLink: false,
	};
}
