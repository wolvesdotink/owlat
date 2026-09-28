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
 * The shared directory reports its `paths` even when the pair is not there yet.
 * On a fresh VPS install the `acme` sidecar publishes the certificate minutes
 * after the MTA boots, so the listener starts without STARTTLS and the reloader
 * installs the pair when it appears. `unavailable` says why nothing was loaded.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BounceTlsMaterial {
	cert?: string;
	key?: string;
	/**
	 * Where a file-sourced pair came from, or where it is expected to appear
	 * (TLS_CERT_DIR). Absent for inline PEM or a half pair.
	 */
	paths?: { cert: string; key: string };
	/** Set when `paths` are watched but held no readable pair at boot. */
	unavailable?: string;
}

type Env = Record<string, string | undefined>;

function readPem(path: string, envName: string): string {
	try {
		return readFileSync(path, 'utf-8');
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
		throw new Error(
			code === 'EACCES'
				? `Cannot read inbound SMTP TLS material at ${path} (${envName}): permission denied for uid ${uid}. ` +
						'Whatever writes the cert must hand ownership to the MTA runtime user ' +
						'(docker-compose.yml: imap-cert-init chowns to IMAP_RUNTIME_USER).'
				: `Cannot read inbound SMTP TLS material at ${path} (${envName}): ${code ?? String(err)}.`,
			{ cause: err }
		);
	}
}

export function loadBounceTlsMaterial(env: Env = process.env): BounceTlsMaterial {
	if (env['BOUNCE_TLS_CERT'] || env['BOUNCE_TLS_KEY']) {
		return {
			...(env['BOUNCE_TLS_CERT'] ? { cert: env['BOUNCE_TLS_CERT'] } : {}),
			...(env['BOUNCE_TLS_KEY'] ? { key: env['BOUNCE_TLS_KEY'] } : {}),
		};
	}

	const certFile = env['BOUNCE_TLS_CERT_FILE'];
	const keyFile = env['BOUNCE_TLS_KEY_FILE'];
	if (certFile || keyFile) {
		// Explicitly configured paths fail loudly: a typo must not quietly boot a
		// listener that rejects all inbound mail.
		return {
			...(certFile ? { cert: readPem(certFile, 'BOUNCE_TLS_CERT_FILE') } : {}),
			...(keyFile ? { key: readPem(keyFile, 'BOUNCE_TLS_KEY_FILE') } : {}),
			...(certFile && keyFile ? { paths: { cert: certFile, key: keyFile } } : {}),
		};
	}

	const certDir = env['TLS_CERT_DIR'];
	if (!certDir) return {};
	const paths = { cert: join(certDir, 'default.crt'), key: join(certDir, 'default.key') };
	if (!existsSync(paths.cert) || !existsSync(paths.key)) {
		return { paths, unavailable: `${paths.cert} and ${paths.key} do not exist yet` };
	}
	return {
		cert: readPem(paths.cert, 'TLS_CERT_DIR'),
		key: readPem(paths.key, 'TLS_CERT_DIR'),
		paths,
	};
}
