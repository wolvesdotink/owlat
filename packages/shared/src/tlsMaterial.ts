/**
 * Boot-time loading of a TLS certificate/key pair for a mail listener.
 *
 * NODE-ONLY: reads files. Exposed via the `@owlat/shared/tlsMaterial` subpath
 * ONLY, next to `tlsCertReloader`; it must never be re-exported from the `.`
 * barrel, which has to stay browser-safe.
 *
 * IMAPS (993) and the MTA's inbound SMTP listener (25) read the same shared
 * mail-certs volume, so one operator mistake has to behave the same on both
 * ports. Sources, first match wins, each as a whole pair so a cert and key from
 * different places are never combined:
 *
 *  1. Inline PEM in the two `inline*` variables.
 *  2. PEM file paths in the two `*File` variables.
 *  3. `${certDir}/default.{crt,key}`, when both files exist.
 *
 * Configuration mistakes fail the boot instead of quietly starting a listener
 * without TLS: half a pair (inline or file) throws, and an explicitly
 * configured file that is missing or unreadable throws. Only the directory
 * fallback is optional, because on a fresh install the volume may still be
 * empty.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Env = Record<string, string | undefined>;

export interface TlsMaterialOptions {
	/** Where the variables are read from. Defaults to `process.env`. */
	env?: Env;
	/** Name of the variable holding the inline certificate PEM. */
	inlineCert: string;
	/** Name of the variable holding the inline private key PEM. */
	inlineKey: string;
	/** Name of the variable holding the certificate file path. */
	certFile: string;
	/** Name of the variable holding the private key file path. */
	keyFile: string;
	/** Directory holding `default.{crt,key}`; `undefined` skips the fallback. */
	certDir: string | undefined;
	/** Who is reading, for error messages ("IMAP", "inbound SMTP"). */
	label: string;
	/** Extra operator guidance appended to a permission-denied error. */
	ownershipHint?: string;
}

export interface TlsMaterial {
	cert: string;
	key: string;
	/**
	 * Set when the pair was read from files, so the listener can re-read them
	 * after a renewal (`tlsCertReloader`). Inline PEM has none.
	 */
	paths?: { cert: string; key: string };
}

function currentUid(): number | string {
	return typeof process.getuid === 'function' ? process.getuid() : 'unknown';
}

function readPem(path: string, source: string, options: TlsMaterialOptions): string {
	const { label, ownershipHint } = options;
	try {
		return readFileSync(path, 'utf-8');
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// A root-written 0600 key on the shared volume passes `existsSync` and
		// then fails the read. The bare `EACCES` names no cause and no fix, and
		// once crash-looped a live IMAP container 724 times, so say both.
		const message =
			code === 'EACCES'
				? `Cannot read ${label} TLS material at ${path} (${source}): permission denied for ` +
					`uid ${currentUid()}. Whatever writes the cert must hand ownership over to this ` +
					'uid (docker-compose.yml: imap-cert-init chowns to IMAP_RUNTIME_USER).' +
					(ownershipHint ? ` ${ownershipHint}` : '')
				: `Cannot read ${label} TLS material at ${path} (${source}): ${code ?? String(err)}.`;
		throw new Error(message, { cause: err });
	}
}

function halfPairError(label: string, set: string, unset: string): Error {
	return new Error(
		`${label} TLS is half configured: ${set} is set but ${unset} is not. ` +
			'Set both, or neither to use the next source.'
	);
}

/**
 * Load the listener's TLS pair, or `null` when no source is configured and the
 * cert directory holds no complete pair.
 */
export function loadTlsMaterial(options: TlsMaterialOptions): TlsMaterial | null {
	const env = options.env ?? process.env;
	const { label } = options;

	const inlineCert = env[options.inlineCert];
	const inlineKey = env[options.inlineKey];
	if (inlineCert && inlineKey) return { cert: inlineCert, key: inlineKey };
	if (inlineCert) throw halfPairError(label, options.inlineCert, options.inlineKey);
	if (inlineKey) throw halfPairError(label, options.inlineKey, options.inlineCert);

	const certFile = env[options.certFile];
	const keyFile = env[options.keyFile];
	if (certFile && keyFile) {
		return {
			cert: readPem(certFile, options.certFile, options),
			key: readPem(keyFile, options.keyFile, options),
			paths: { cert: certFile, key: keyFile },
		};
	}
	if (certFile) throw halfPairError(label, options.certFile, options.keyFile);
	if (keyFile) throw halfPairError(label, options.keyFile, options.certFile);

	const { certDir } = options;
	if (!certDir) return null;
	const certPath = join(certDir, 'default.crt');
	const keyPath = join(certDir, 'default.key');
	if (!existsSync(certPath) || !existsSync(keyPath)) return null;
	return {
		cert: readPem(certPath, 'TLS_CERT_DIR', options),
		key: readPem(keyPath, 'TLS_CERT_DIR', options),
		paths: { cert: certPath, key: keyPath },
	};
}
