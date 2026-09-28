/**
 * TLS material for the inbound (bounce) SMTP listener on port 25.
 *
 * Without a certificate the listener cannot offer STARTTLS, and the default-on
 * "Require TLS for incoming mail" floor then rejects every inbound delivery —
 * bounces and DSNs included. Sources, first match wins, each as a whole pair so
 * a cert and key from different places can never be combined:
 *
 *  1. `BOUNCE_TLS_CERT` / `BOUNCE_TLS_KEY` — inline PEM.
 *  2. `BOUNCE_TLS_CERT_FILE` / `BOUNCE_TLS_KEY_FILE` — PEM file paths.
 *  3. `${TLS_CERT_DIR}/default.{crt,key}` — the shared mail-certs volume the
 *     IMAP server reads too (self-signed by `imap-cert-init` on a self-host,
 *     ACME-issued by the VPS template's `acme` sidecar).
 *
 * A pair read from files also reports its `paths`, so the running listener can
 * re-read them when the certificate is renewed (bounce/tlsReload.ts). Inline
 * PEM cannot change without a restart and reports none.
 *
 * The rules live in `@owlat/shared/tlsMaterial`, shared with IMAPS: half a pair
 * or an explicitly configured file that is missing or unreadable fails the
 * boot, so a typo cannot quietly start a listener that rejects all inbound
 * mail. Unlike IMAP there is no default cert directory: without
 * `TLS_CERT_DIR` the third source is skipped.
 */

import { loadTlsMaterial } from '@owlat/shared/tlsMaterial';

export interface BounceTlsMaterial {
	cert?: string;
	key?: string;
	/** Where a file-sourced pair came from; absent for inline PEM. */
	paths?: { cert: string; key: string };
}

/** The pair for the port-25 listener; an empty object when none is configured. */
export function loadBounceTlsMaterial(
	env: Record<string, string | undefined> = process.env
): BounceTlsMaterial {
	return (
		loadTlsMaterial({
			env,
			inlineCert: 'BOUNCE_TLS_CERT',
			inlineKey: 'BOUNCE_TLS_KEY',
			certFile: 'BOUNCE_TLS_CERT_FILE',
			keyFile: 'BOUNCE_TLS_KEY_FILE',
			certDir: env['TLS_CERT_DIR'],
			label: 'inbound SMTP',
		}) ?? {}
	);
}
