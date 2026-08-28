/**
 * Plain-language quarantine outcomes (UX plan idea 53).
 *
 * The quarantine review page used to hand a non-expert the backend's own
 * vocabulary — a raw `injectionType` enum (`instruction_smuggling`) and a bare
 * confidence percentage — and ask them to make a security decision from it. This
 * repo already solved that problem once: `utils/trustLabel.ts` replaced a score
 * with "Ready to send / Worth a look / Needs you", and this follows the same
 * shape.
 *
 * Three layers, in the order a reader needs them:
 *   1. `headline` — what happened and why, in one sentence, outcome first
 *      ("We held this back because …").
 *   2. `reasons`  — the individual observations that fired, as bullets. Every
 *      one maps 1:1 to a field the scan actually set; nothing is inferred.
 *   3. `detail`   — the raw enum and the confidence number, demoted to a quiet
 *      footer for whoever wants to check the machine's work.
 *
 * Module scope, so nothing here calls `useI18n`: every human-facing string is a
 * catalog KEY, or a `{ key, params }` pair, resolved at the render boundary. The
 * one exception is `sample`, which is a verbatim excerpt of the held message —
 * evidence, not copy, and the page renders it as such.
 */

/** A translatable sentence: a bare catalog key, or a key plus its values. */
export type QuarantineText = string | { key: string; params?: Record<string, string | number> };

/** The scan record persisted on `inboundMessages.securityFlags`. */
export interface QuarantineSecurityFlags {
	injectionDetected?: boolean;
	injectionType?: string;
	confidence?: number;
	flaggedContent?: string;
	spamScore?: number;
	phishingDetected?: boolean;
	/** The guard-tier classifier could not run at all (model error / empty sample). */
	guardUnavailable?: boolean;
	scanTimestamp?: number;
}

export interface QuarantineReason {
	/** Outcome-first sentence: what we did, and the single strongest why. */
	headline: QuarantineText;
	/** The observations that fired, strongest first. Never empty. */
	reasons: QuarantineText[];
	/** Verbatim excerpt from the held message, when the scan captured one. */
	sample?: string;
	/** Quiet power-user footer: the raw enum and the confidence number. */
	detail: QuarantineText;
}

/**
 * Plain-language explanation per injection type. The taxonomy is a backend enum,
 * so an UNKNOWN value falls back to the generic line rather than rendering the
 * enum in the reader's face — the raw value still travels, in the footer, where
 * an operator can act on it.
 */
const INJECTION_COPY: Record<string, { headline: string; reason: string }> = {
	direct_injection: {
		headline: 'dashboard.inbox.quarantine.outcomes.directInjection.headline',
		reason: 'dashboard.inbox.quarantine.outcomes.directInjection.reason',
	},
	instruction_smuggling: {
		headline: 'dashboard.inbox.quarantine.outcomes.instructionSmuggling.headline',
		reason: 'dashboard.inbox.quarantine.outcomes.instructionSmuggling.reason',
	},
	delimiter_attack: {
		headline: 'dashboard.inbox.quarantine.outcomes.delimiterAttack.headline',
		reason: 'dashboard.inbox.quarantine.outcomes.delimiterAttack.reason',
	},
	encoding_evasion: {
		headline: 'dashboard.inbox.quarantine.outcomes.encodingEvasion.headline',
		reason: 'dashboard.inbox.quarantine.outcomes.encodingEvasion.reason',
	},
	role_impersonation: {
		headline: 'dashboard.inbox.quarantine.outcomes.roleImpersonation.headline',
		reason: 'dashboard.inbox.quarantine.outcomes.roleImpersonation.reason',
	},
};

const GENERIC = {
	headline: 'dashboard.inbox.quarantine.outcomes.generic.headline',
	reason: 'dashboard.inbox.quarantine.outcomes.generic.reason',
};

const PHISHING = {
	headline: 'dashboard.inbox.quarantine.outcomes.phishing.headline',
	reason: 'dashboard.inbox.quarantine.outcomes.phishing.reason',
};

const GUARD_UNAVAILABLE = {
	headline: 'dashboard.inbox.quarantine.outcomes.guardUnavailable.headline',
	reason: 'dashboard.inbox.quarantine.outcomes.guardUnavailable.reason',
};

/** At or above this score the spam filters are worth mentioning as a reason. */
export const QUARANTINE_SPAM_SCORE_NOTABLE = 5;

/**
 * Turn one scan record into the three layers above.
 *
 * The headline names the STRONGEST signal, in the order a reader cares about:
 * impersonation of a person (phishing) beats a machine-directed attack, which
 * beats "we could not check at all". Every fired signal still appears as a
 * bullet, so the headline narrows the message without hiding anything.
 *
 * `flags` is optional because a quarantined row may carry no scan record at all
 * (held by an earlier stage). That case is honest rather than silent: the
 * generic outcome, one reason saying the check left no record, and a footer that
 * says so too instead of printing a fabricated 0%.
 */
export function deriveQuarantineReason(
	flags: QuarantineSecurityFlags | undefined
): QuarantineReason {
	if (!flags) {
		return {
			headline: GENERIC.headline,
			reasons: ['dashboard.inbox.quarantine.outcomes.noRecord.reason'],
			detail: 'dashboard.inbox.quarantine.footer.noRecord',
		};
	}

	const injection = flags.injectionDetected === true;
	const injectionCopy = injection
		? (INJECTION_COPY[(flags.injectionType ?? '').trim().toLowerCase()] ?? GENERIC)
		: null;

	const reasons: QuarantineText[] = [];
	if (flags.phishingDetected === true) reasons.push(PHISHING.reason);
	if (injectionCopy) reasons.push(injectionCopy.reason);
	if (flags.guardUnavailable === true) reasons.push(GUARD_UNAVAILABLE.reason);
	if ((flags.spamScore ?? 0) >= QUARANTINE_SPAM_SCORE_NOTABLE) {
		reasons.push('dashboard.inbox.quarantine.outcomes.spam.reason');
	}
	// Never an empty list: something put this message here, and "we cannot say
	// what" is a truthful answer where a blank space is not.
	if (reasons.length === 0) reasons.push(GENERIC.reason);

	const headline =
		flags.phishingDetected === true
			? PHISHING.headline
			: injectionCopy
				? injectionCopy.headline
				: flags.guardUnavailable === true
					? GUARD_UNAVAILABLE.headline
					: GENERIC.headline;

	const sample = flags.flaggedContent?.trim();

	return {
		headline,
		reasons,
		...(sample ? { sample } : {}),
		detail: quarantineDetail(flags),
	};
}

/**
 * The quiet footer. The raw enum travels as an interpolated VALUE (it is data,
 * not copy — translating it would break the operator's ability to grep for it),
 * and a scan that recorded no confidence says so rather than printing 0%.
 */
function quarantineDetail(flags: QuarantineSecurityFlags): QuarantineText {
	const type = flags.injectionType?.trim();
	const percent = typeof flags.confidence === 'number' ? Math.round(flags.confidence * 100) : null;
	if (type && percent !== null) {
		return {
			key: 'dashboard.inbox.quarantine.footer.typeAndConfidence',
			params: { type, percent },
		};
	}
	if (type) return { key: 'dashboard.inbox.quarantine.footer.typeOnly', params: { type } };
	if (percent !== null) {
		return { key: 'dashboard.inbox.quarantine.footer.confidenceOnly', params: { percent } };
	}
	return 'dashboard.inbox.quarantine.footer.noRecord';
}
