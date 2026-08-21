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

/** Message-key root for this module; see `i18n/locales/en.json`. */
const K = 'shared.campaignSenderVerification';

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

/**
 * Advisory copy carries message KEYS, never sentences: this module is
 * framework-free, so it cannot call `useI18n`. Copy that names the domain
 * travels as its key plus that value, and the modal that renders it translates
 * (`t(value)` / `t(value.key, value.params)`).
 */
export type SenderVerificationMessage = string | { key: string; params?: Record<string, unknown> };

export interface SenderVerification {
	tone: SenderVerificationTone;
	message: SenderVerificationMessage;
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
			message: `${K}.enterAddress`,
			canAdd: false,
			showDomainsLink: false,
		};
	}
	if (checkFailed) {
		return {
			tone: 'warning',
			message: `${K}.checkFailed`,
			canAdd: false,
			showDomainsLink: false,
		};
	}
	if (!status) {
		return {
			tone: 'neutral',
			message: `${K}.checking`,
			canAdd: false,
			showDomainsLink: false,
		};
	}
	if (!status.exists) {
		return {
			tone: 'warning',
			message: { key: `${K}.domainMissing`, params: { domain: status.domain } },
			canAdd: false,
			showDomainsLink: true,
		};
	}
	if (!status.verified) {
		return {
			tone: 'warning',
			message: { key: `${K}.domainUnverified`, params: { domain: status.domain } },
			canAdd: false,
			showDomainsLink: true,
		};
	}
	return {
		tone: 'success',
		message: { key: `${K}.domainVerified`, params: { domain: status.domain } },
		canAdd: true,
		showDomainsLink: false,
	};
}
