/**
 * The From address of system mail: account verification, password resets,
 * invitations, account deletion, double opt-in, booking invites and
 * deliverability alerts.
 *
 * There is deliberately no built-in fallback. Mail sent under a domain the
 * operator does not control fails SPF and DMARC at the recipient and spends
 * that domain's reputation, so an install with no sender configured refuses
 * the mail with a configuration error, as it does when no transport is set.
 * The setup wizards write `DEFAULT_FROM_*` (`@owlat/shared/systemFromIdentity`).
 */

import { getOptional } from './env';

export const SYSTEM_SENDER_NOT_CONFIGURED_MESSAGE =
	'No system mail sender is configured: set DEFAULT_FROM_DOMAIN (system mail is sent as noreply@ that domain) or DEFAULT_FROM_EMAIL in the deployment environment, on a domain whose SPF and DMARC you control.';

export class SystemSenderNotConfiguredError extends Error {
	constructor() {
		super(SYSTEM_SENDER_NOT_CONFIGURED_MESSAGE);
		this.name = 'SystemSenderNotConfiguredError';
	}
}

/**
 * `noreply@DEFAULT_FROM_DOMAIN`, else `DEFAULT_FROM_EMAIL`, else null. The
 * domain wins when both are set because system mail has always been sent as
 * noreply@ that domain, and an install configured that way keeps its From.
 */
export function systemSenderAddress(): string | null {
	const domain = getOptional('DEFAULT_FROM_DOMAIN')?.trim();
	if (domain) return `noreply@${domain}`;
	return getOptional('DEFAULT_FROM_EMAIL')?.trim() || null;
}

/** {@link systemSenderAddress}, throwing {@link SystemSenderNotConfiguredError} when absent. */
export function requireSystemSenderAddress(): string {
	const address = systemSenderAddress();
	if (!address) throw new SystemSenderNotConfiguredError();
	return address;
}
