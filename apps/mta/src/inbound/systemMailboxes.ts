/**
 * `postmaster@` and `abuse@` on the hosts this MTA sends as.
 *
 * RFC 5321 §4.5.1 and RFC 2142 require `postmaster`, and the mailbox providers'
 * feedback loops and blocklist delisting forms expect a working `abuse` (or
 * `postmaster`) on the sending domain. Owlat names `postmaster@<return-path
 * domain>` as its own TLS-RPT contact. The hosts are the return-path domain and
 * every EHLO name, because those are the names a receiver sees on our mail.
 *
 * Hosted-mailbox and customer domains are left out on purpose: the domain's
 * owner answers for its postmaster, and mail for one tenant's domain must not
 * reach the operators of the whole instance.
 */

import type { MtaConfig } from '../config.js';

const SYSTEM_MAILBOX_LOCAL_PARTS: ReadonlySet<string> = new Set(['postmaster', 'abuse']);

/** The lowercase hosts that answer for `postmaster@` and `abuse@`. */
export function systemMailboxHosts(
	config: Pick<MtaConfig, 'returnPathDomain' | 'ehloHostname' | 'ehloHostnames'>
): string[] {
	const hosts = [
		config.returnPathDomain,
		config.ehloHostname,
		...Object.values(config.ehloHostnames ?? {}),
	];
	return [...new Set(hosts.filter(Boolean).map((host) => host.toLowerCase().replace(/\.$/, '')))];
}

/**
 * Whether `address` is `postmaster@` or `abuse@` one of `hosts`. Both local
 * parts are matched without regard to case, as RFC 5321 requires for
 * `postmaster`.
 */
export function isSystemMailboxAddress(address: string, hosts: readonly string[]): boolean {
	const at = address.lastIndexOf('@');
	if (at < 1) return false;
	const local = address.slice(0, at).toLowerCase();
	const host = address
		.slice(at + 1)
		.toLowerCase()
		.replace(/\.$/, '');
	return SYSTEM_MAILBOX_LOCAL_PARTS.has(local) && hosts.includes(host);
}

/**
 * Whether mail to `address` is meant as complaint feedback: a `fbl+…@` address
 * or one of the system mailboxes. Only there is a plain forward of one of our
 * messages read as a complaint; anywhere else it is just a forward.
 */
export function isComplaintMailbox(address: string | undefined, hosts: readonly string[]): boolean {
	if (!address) return false;
	return address.toLowerCase().startsWith('fbl+') || isSystemMailboxAddress(address, hosts);
}
