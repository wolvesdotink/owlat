/**
 * Picks up a renewed IMAPS certificate without a restart.
 *
 * The server reads its pair once at boot. When that pair came from files (the
 * shared mail-certs volume, or IMAP_TLS_*_FILE), the VPS template's `acme`
 * sidecar replaces them on renewal; this re-reads them on an interval and
 * swaps the server's secure context, so the next handshake presents the new
 * certificate. Connections already open keep the one they negotiated.
 */

import type { Server as TlsServer, TlsOptions } from 'tls';
import { startTlsCertReloader, type TlsCertReloader } from '@owlat/shared/tlsCertReloader';
import type { ImapConfig } from './config.js';
import { logger } from './logger.js';

/**
 * Start watching `tls.paths`, if any. `baseOptions` is the server's cipher
 * policy, re-applied with every new pair so a reload cannot loosen it.
 * Returns `undefined` for inline PEM, which never changes.
 */
export function startImapTlsReload(
	server: Pick<TlsServer, 'setSecureContext'>,
	tls: NonNullable<ImapConfig['tls']>,
	baseOptions: TlsOptions
): TlsCertReloader | undefined {
	if (!tls.paths) return undefined;
	return startTlsCertReloader({
		certPath: tls.paths.cert,
		keyPath: tls.paths.key,
		initial: { cert: tls.cert, key: tls.key },
		apply: ({ cert, key }) => server.setSecureContext({ ...baseOptions, cert, key }),
		log: {
			info: (message, detail) => logger.info(detail, message),
			warn: (message, detail) => logger.warn(detail, message),
		},
	});
}
