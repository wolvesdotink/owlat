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
 * The rules for inline PEM and explicit files live in
 * `@owlat/shared/tlsMaterial`, shared with IMAPS: half a pair or an explicitly
 * configured file that is missing or unreadable fails the boot, so a typo
 * cannot quietly start a listener that rejects all inbound mail. Unlike IMAP
 * there is no default cert directory: without `TLS_CERT_DIR` the third source
 * is skipped.
 *
 * The shared directory reports its `paths` even when the pair is not there yet
 * or cannot be read yet. On a fresh VPS install the `acme` sidecar publishes
 * the certificate minutes after the MTA boots (and briefly holds it root-owned
 * while doing so), so the listener starts without STARTTLS and the reloader
 * installs the pair when it appears. `unavailable` says why nothing was loaded.
 */

import { join } from 'node:path';
import { loadTlsMaterial, type TlsMaterialOptions } from '@owlat/shared/tlsMaterial';

export interface BounceTlsMaterial {
	cert?: string;
	key?: string;
	/**
	 * Where a file-sourced pair came from, or where it is expected to appear
	 * (TLS_CERT_DIR). Absent for inline PEM.
	 */
	paths?: { cert: string; key: string };
	/** Set when `paths` are watched but held no readable pair at boot. */
	unavailable?: string;
}

type Env = Record<string, string | undefined>;

const SOURCES = {
	inlineCert: 'BOUNCE_TLS_CERT',
	inlineKey: 'BOUNCE_TLS_KEY',
	certFile: 'BOUNCE_TLS_CERT_FILE',
	keyFile: 'BOUNCE_TLS_KEY_FILE',
	label: 'inbound SMTP',
} satisfies Omit<TlsMaterialOptions, 'env' | 'certDir'>;

/**
 * The pair for the port-25 listener; an empty object when none is configured,
 * or the watched `TLS_CERT_DIR` paths plus `unavailable` when the shared pair
 * is not readable yet.
 */
export function loadBounceTlsMaterial(env: Env = process.env): BounceTlsMaterial {
	const configured = loadTlsMaterial({ ...SOURCES, env, certDir: undefined });
	if (configured) return configured;

	const certDir = env['TLS_CERT_DIR'];
	if (!certDir) return {};
	const paths = { cert: join(certDir, 'default.crt'), key: join(certDir, 'default.key') };
	// The implicit shared directory is waited on, not failed on: throwing here
	// would crash-loop the whole MTA, outbound delivery included, over a cert
	// the publisher is still in the middle of writing. An empty env leaves the
	// directory as the only source the shared loader consults.
	try {
		return (
			loadTlsMaterial({ ...SOURCES, env: {}, certDir }) ?? {
				paths,
				unavailable: `${paths.cert} and ${paths.key} do not exist yet`,
			}
		);
	} catch (err) {
		return { paths, unavailable: err instanceof Error ? err.message : String(err) };
	}
}
