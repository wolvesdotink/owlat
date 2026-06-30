/**
 * Loopback detection for external IMAP/SMTP hosts.
 *
 * Plaintext (non-TLS) IMAP/SMTP is only safe to a loopback address — a local
 * Proton Bridge / relay on the same box. Allowing plaintext to an arbitrary
 * remote host would ship the user's mailbox credentials over the wire in the
 * clear. So a self-hoster may disable TLS only when the host is loopback.
 */

/**
 * True when `host` is a loopback address (the only host for which plaintext
 * IMAP/SMTP is permitted). Bracket- and trailing-dot-aware; covers IPv4
 * 127.0.0.0/8, IPv6 ::1, and IPv4-mapped IPv6 loopback.
 */
export function isLocalMailHost(host: string): boolean {
	let h = host.trim().toLowerCase();
	if (h === '') return false;
	if (h.endsWith('.')) h = h.slice(0, -1); // strip the FQDN root dot
	if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1); // [::1] → ::1
	if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
	if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true; // 127.0.0.0/8
	if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true; // v4-mapped loopback
	return false;
}
