/**
 * Hot reload of a TLS certificate/key pair that lives on disk.
 *
 * NODE-ONLY: reads files and builds `tls` secure contexts. Exposed via the
 * `@owlat/shared/tlsCertReloader` subpath ONLY — it must never be re-exported
 * from the `.` barrel, which has to stay browser-safe.
 *
 * The MTA's inbound SMTP listener and the IMAP server both serve
 * `default.{crt,key}` from the shared mail-certs volume. The VPS template's
 * `acme` sidecar renews that certificate and republishes it into the volume;
 * without a reload both processes keep serving the certificate they read at
 * boot until it expires. This module re-reads the pair on an interval and hands
 * a changed, VALID pair to the caller, which swaps its secure context in place.
 *
 * Polling on content rather than `fs.watch`: on a Docker volume the publisher
 * may replace the files (install/rename), which inotify reports inconsistently
 * or not at all across bind mounts and overlay filesystems. Two small reads
 * every few minutes cost nothing and see every kind of replacement.
 *
 * Failure never lowers the posture. An unreadable file, a half-published pair
 * (new cert, old key) or a garbage PEM logs one warning and the current context
 * stays in service; a pair that failed is not retried or re-logged until the
 * files change again. There is no path from here to "no TLS".
 */

import { createHash, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSecureContext } from 'node:tls';

/** How often the pair is re-read when the caller does not say otherwise. */
const DEFAULT_TLS_CERT_RELOAD_INTERVAL_MS = 5 * 60 * 1_000;

/** A PEM certificate (chain) and its private key. */
export interface TlsCertMaterial {
	cert: string;
	key: string;
}

/**
 * Log sink. Callers adapt their own logger (pino in the mail sidecars) rather
 * than this module dragging one into `@owlat/shared`.
 */
export type TlsCertReloadLog = (message: string, detail: Record<string, unknown>) => void;

export interface TlsCertReloaderOptions {
	certPath: string;
	keyPath: string;
	/** The pair the caller is serving right now (read at boot). */
	initial: TlsCertMaterial;
	/**
	 * Install a validated pair. Throwing rejects it: the reloader keeps the
	 * current pair and logs a warning, exactly as for an invalid pair.
	 */
	apply: (material: TlsCertMaterial) => void;
	log: { info: TlsCertReloadLog; warn: TlsCertReloadLog };
	/** Poll interval. Default {@link DEFAULT_TLS_CERT_RELOAD_INTERVAL_MS}. */
	intervalMs?: number;
	/** Test seam. Defaults to a UTF-8 `fs.promises.readFile`. */
	readFile?: (path: string) => Promise<string>;
}

export interface TlsCertReloader {
	/** The pair currently in service. */
	current(): TlsCertMaterial;
	/**
	 * Re-read the files now. Resolves `true` when a new pair was installed.
	 * Never rejects; concurrent calls share one in-flight check.
	 */
	check(): Promise<boolean>;
	/** Stop polling. Idempotent. */
	stop(): void;
}

/** Subject and expiry of the leaf certificate, for the reload log line. */
function describeCertificate(certPem: string): { subject: string; notAfter: string } {
	const certificate = new X509Certificate(certPem);
	const validTo = Date.parse(certificate.validTo);
	return {
		subject: certificate.subject.replace(/\n/g, ', '),
		notAfter: Number.isFinite(validTo) ? new Date(validTo).toISOString() : certificate.validTo,
	};
}

function fingerprint(material: TlsCertMaterial): string {
	return createHash('sha256').update(material.cert).update('\0').update(material.key).digest('hex');
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Start polling `certPath`/`keyPath`. The timer is unref'd so it never holds
 * the process open; call {@link TlsCertReloader.stop} on shutdown.
 */
export function startTlsCertReloader(options: TlsCertReloaderOptions): TlsCertReloader {
	const read = options.readFile ?? ((path: string) => readFile(path, 'utf8'));
	const { certPath, keyPath, log } = options;
	let current: TlsCertMaterial = options.initial;
	// The last failure, so a persistent problem is reported once per distinct
	// cause instead of once per tick.
	let lastFailure: string | undefined;
	let inFlight: Promise<boolean> | undefined;

	const fail = (key: string, message: string, detail: Record<string, unknown>): false => {
		if (lastFailure !== key) {
			lastFailure = key;
			log.warn(message, { certPath, keyPath, ...detail });
		}
		return false;
	};

	const runCheck = async (): Promise<boolean> => {
		let next: TlsCertMaterial;
		try {
			const [cert, key] = await Promise.all([read(certPath), read(keyPath)]);
			next = { cert, key };
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? errorMessage(err);
			return fail(
				`read:${code}`,
				'TLS certificate reload failed: cannot read the files; keeping the current certificate',
				{ error: errorMessage(err) }
			);
		}
		if (next.cert === current.cert && next.key === current.key) {
			lastFailure = undefined;
			return false;
		}
		const nextFingerprint = fingerprint(next);
		if (lastFailure === `pair:${nextFingerprint}`) return false;
		try {
			// Building a context is the validation: it rejects unparseable PEM and a
			// key that does not belong to the certificate ("key values mismatch").
			createSecureContext({ cert: next.cert, key: next.key });
			const summary = describeCertificate(next.cert);
			options.apply(next);
			current = next;
			lastFailure = undefined;
			log.info('TLS certificate reloaded', { certPath, ...summary });
			return true;
		} catch (err) {
			return fail(
				`pair:${nextFingerprint}`,
				'TLS certificate reload failed: the new pair is invalid; keeping the current certificate',
				{ error: errorMessage(err) }
			);
		}
	};

	const check = (): Promise<boolean> => {
		if (!inFlight) {
			inFlight = runCheck().finally(() => {
				inFlight = undefined;
			});
		}
		return inFlight;
	};

	const timer = setInterval(() => {
		void check();
	}, options.intervalMs ?? DEFAULT_TLS_CERT_RELOAD_INTERVAL_MS);
	timer.unref();

	return {
		current: () => current,
		check,
		stop: () => clearInterval(timer),
	};
}
