/**
 * From-header formatting shared by every send producer. The send-time
 * verified-domain gate is `checkEmailDomainVerification` in
 * `domains/domains.ts`.
 */

/**
 * Build an RFC 5322 From header. With a display name, returns
 * `Name <email>`; otherwise the bare address. Single source of truth for
 * the From-header shape across every send producer.
 */
export function formatFromAddress(email: string, name?: string): string {
	return name ? `${name} <${email}>` : email;
}
