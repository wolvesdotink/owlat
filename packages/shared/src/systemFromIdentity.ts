/**
 * The From identity of system mail: account verification, password reset,
 * invitations and alerts, plus the transactional API's fallback sender.
 *
 * Every setup path (the terminal wizard, the `--config` / `--assume-yes` mapper
 * and the web wizard's apply step) derives `DEFAULT_FROM_*` here, so they write
 * the same values for the same sending hostname. Left unset, the Convex
 * runtime falls back to a placeholder domain the operator does not own, and the
 * first verification mail fails SPF and DMARC at the recipient.
 *
 * The sending hostname (`EHLO_HOSTNAME`) is the proposal because it is the one
 * domain every MTA install already controls DNS for. It is not DKIM-signed by
 * default: the MTA signs only domains added in the app. With the bounce domain
 * under the same parent domain, SPF still aligns in relaxed mode.
 */

/** The display name system mail carries when the operator names none. */
const SYSTEM_FROM_NAME = 'Owlat';

/** The address a setup wizard proposes for system mail sent as `sendingHostname`. */
export function proposedSystemFromEmail(sendingHostname: string): string {
	return `noreply@${sendingHostname.trim()}`;
}

export interface SystemFromIdentityEnv {
	DEFAULT_FROM_DOMAIN: string;
	DEFAULT_FROM_EMAIL: string;
	DEFAULT_FROM_NAME: string;
}

/**
 * `DEFAULT_FROM_*` for a sending hostname. `email` and `name` replace the
 * proposal when the operator chose their own; the domain always follows the
 * address, so the two can never name different domains.
 */
export function systemFromIdentityEnv(
	sendingHostname: string,
	email?: string,
	name?: string
): SystemFromIdentityEnv {
	const address = email?.trim() || proposedSystemFromEmail(sendingHostname);
	const at = address.lastIndexOf('@');
	return {
		DEFAULT_FROM_DOMAIN: at === -1 ? sendingHostname.trim() : address.slice(at + 1),
		DEFAULT_FROM_EMAIL: address,
		DEFAULT_FROM_NAME: name?.trim() || SYSTEM_FROM_NAME,
	};
}
