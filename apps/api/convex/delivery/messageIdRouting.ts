/**
 * Provider message ID routing.
 *
 * Postbox personal-mail outbound dispatches carry a `pb-` prefix on their
 * provider message ID; everything else is a Send (campaign or transactional)
 * resolved through sendLifecycle. This module owns the prefix convention so
 * the Webhook dispatcher and the workpool completion path agree.
 *
 * Broader orchestration cleanup (one module owning both workpool completion
 * and provider feedback) is deferred to a follow-up ADR — see candidate #5
 * in ADR-0003.
 */

const POSTBOX_PROVIDER_MESSAGE_ID_PREFIX = 'pb-';

export function isPostboxMessageId(providerMessageId: string): boolean {
	return providerMessageId.startsWith(POSTBOX_PROVIDER_MESSAGE_ID_PREFIX);
}

/**
 * Return-path capability PROBES carry their own prefix. A probe is not a Send:
 * its bounce is EVIDENCE that a relay preserved our VERP envelope sender, and
 * it must never reach the Send lifecycle or a campaign's numbers. Same reason
 * the Postbox prefix lives here — the dispatcher and the completion path have
 * to agree on the convention, so the convention has exactly one home.
 */
const RETURN_PATH_PROBE_MESSAGE_ID_PREFIX = 'rp-probe.';

/** The message id a return-path probe sends under. */
export function returnPathProbeMessageId(probeId: string): string {
	return `${RETURN_PATH_PROBE_MESSAGE_ID_PREFIX}${probeId}`;
}

/** Is this attributed message id one of our return-path probes? */
export function isReturnPathProbeMessageId(messageId: string | undefined): boolean {
	return messageId !== undefined && messageId.startsWith(RETURN_PATH_PROBE_MESSAGE_ID_PREFIX);
}

/** The probe id carried by a probe message id, or null. */
export function probeIdFromMessageId(messageId: string): string | null {
	if (!isReturnPathProbeMessageId(messageId)) return null;
	const probeId = messageId.slice(RETURN_PATH_PROBE_MESSAGE_ID_PREFIX.length);
	return probeId.length > 0 ? probeId : null;
}
