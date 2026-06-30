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
