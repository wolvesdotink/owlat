/**
 * Picks up a renewed inbound SMTP certificate without a restart.
 *
 * The port-25 listener reads its STARTTLS pair once at boot. When that pair
 * came from files (the shared mail-certs volume, or BOUNCE_TLS_*_FILE), the
 * VPS template's `acme` sidecar replaces them on renewal; this re-reads them on
 * an interval and swaps the listener's context, so the next STARTTLS presents
 * the new certificate. `/health`'s `smtpTls` reads {@link currentCert} so it
 * reports the certificate actually in service. Inline PEM never changes and is
 * not watched.
 *
 * On a fresh install the files may not exist yet when the MTA boots: the
 * `acme` sidecar publishes them minutes later. The listener then starts
 * without STARTTLS, and the first valid pair to appear is installed into it,
 * so the next EHLO offers STARTTLS without a restart.
 */

import type { SmtpListener } from '@owlat/smtp-listener';
import { startTlsCertReloader, type TlsCertReloader } from '@owlat/shared/tlsCertReloader';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';

type ReloadConfig = Pick<
	MtaConfig,
	| 'bounceServerTlsCert'
	| 'bounceServerTlsKey'
	| 'bounceServerTlsPaths'
	| 'bounceServerTlsUnavailable'
>;

export interface BounceTlsReload {
	/** The certificate PEM in service (the boot one until a reload succeeds). */
	currentCert(): string | undefined;
	/** Re-read the files now; resolves `true` when a new pair went into service. */
	check(): Promise<boolean>;
	stop(): void;
}

/**
 * Start watching the bounce listener's certificate files. `listener` is read at
 * reload time because the listener is created after the HTTP app, and it may be
 * absent if it failed to bind.
 */
export function startBounceTlsReload(
	config: ReloadConfig,
	listener: () => SmtpListener | undefined
): BounceTlsReload {
	const {
		bounceServerTlsCert: cert,
		bounceServerTlsKey: key,
		bounceServerTlsPaths: paths,
	} = config;
	if (!paths) {
		return {
			currentCert: () => cert,
			check: async () => false,
			stop: () => {},
		};
	}
	const initial = cert && key ? { cert, key } : undefined;
	if (!initial) {
		logger.warn(
			{ certPath: paths.cert, keyPath: paths.key, reason: config.bounceServerTlsUnavailable },
			'Inbound SMTP: no TLS certificate yet; STARTTLS is not offered and inbound mail that requires TLS is refused until the certificate appears. Watching for it.'
		);
	}
	const reloader: TlsCertReloader = startTlsCertReloader({
		certPath: paths.cert,
		keyPath: paths.key,
		...(initial ? { initial } : {}),
		apply: (material) => listener()?.updateTlsMaterial(material),
		log: {
			info: (message, detail) => logger.info(detail, `Inbound SMTP: ${message}`),
			warn: (message, detail) => logger.warn(detail, `Inbound SMTP: ${message}`),
		},
	});
	return {
		currentCert: () => reloader.current()?.cert,
		check: () => reloader.check(),
		stop: () => reloader.stop(),
	};
}
