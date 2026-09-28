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
 *
 * A caller may also start with nothing in service (no `initial`): on a fresh
 * install the certificate is published some minutes after the process boots.
 * The reloader then polls on the shorter `pendingIntervalMs` until the files
 * appear, logs the missing files once, and hands over the first valid pair.
 */

import { createHash, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSecureContext } from 'node:tls';

/** How often the pair is re-read when the caller does not say otherwise. */
const DEFAULT_TLS_CERT_RELOAD_INTERVAL_MS = 5 * 60 * 1_000;

/** How often the files are looked for while no pair is in service yet. */
const DEFAULT_TLS_CERT_PENDING_INTERVAL_MS = 30 * 1_000;

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
	/**
	 * The pair the caller is serving right now (read at boot). Omit it when the
	 * files did not exist yet: the first valid pair that appears is applied.
	 */
	initial?: TlsCertMaterial;
	/**
	 * Install a validated pair. Throwing rejects it: the reloader keeps the
	 * current pair and logs a warning, exactly as for an invalid pair.
	 */
	apply: (material: TlsCertMaterial) => void;
	log: { info: TlsCertReloadLog; warn: TlsCertReloadLog };
	/** Poll interval. Default {@link DEFAULT_TLS_CERT_RELOAD_INTERVAL_MS}. */
	intervalMs?: number;
	/**
	 * Poll interval while no pair is in service, capped at `intervalMs`.
	 * Default {@link DEFAULT_TLS_CERT_PENDING_INTERVAL_MS}.
	 */
	pendingIntervalMs?: number;
	/** Test seam. Defaults to a UTF-8 `fs.promises.readFile`. */
	readFile?: (path: string) => Promise<string>;
}

export interface TlsCertReloader {
	/** The pair currently in service, `undefined` until one has been applied. */
	current(): TlsCertMaterial | undefined;
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
	let current: TlsCertMaterial | undefined = options.initial;
	const intervalMs = options.intervalMs ?? DEFAULT_TLS_CERT_RELOAD_INTERVAL_MS;
	const pendingIntervalMs = Math.min(
		options.pendingIntervalMs ?? DEFAULT_TLS_CERT_PENDING_INTERVAL_MS,
		intervalMs
	);
	let timer: ReturnType<typeof setInterval> | undefined;
	let stopped = false;
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
				current
					? 'TLS certificate reload failed: cannot read the files; keeping the current certificate'
					: 'TLS certificate not available yet: cannot read the files; TLS stays off until they appear',
				{ error: errorMessage(err) }
			);
		}
		if (current && next.cert === current.cert && next.key === current.key) {
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
			const wasPending = current === undefined;
			current = next;
			lastFailure = undefined;
			log.info(wasPending ? 'TLS certificate loaded' : 'TLS certificate reloaded', {
				certPath,
				...summary,
			});
			// Something is in service now: drop back to the renewal cadence.
			if (wasPending) schedule();
			return true;
		} catch (err) {
			return fail(
				`pair:${nextFingerprint}`,
				current
					? 'TLS certificate reload failed: the new pair is invalid; keeping the current certificate'
					: 'TLS certificate not available yet: the pair is invalid; TLS stays off until it is replaced',
				{ error: errorMessage(err) }
			);
		}
	};

	function schedule(): void {
		if (timer) clearInterval(timer);
		if (stopped) return;
		timer = setInterval(
			() => {
				void check();
			},
			current ? intervalMs : pendingIntervalMs
		);
		timer.unref();
	}

	const check = (): Promise<boolean> => {
		if (!inFlight) {
			inFlight = runCheck().finally(() => {
				inFlight = undefined;
			});
		}
		return inFlight;
	};

	schedule();

	return {
		current: () => current,
		check,
		stop: () => {
			stopped = true;
			if (timer) clearInterval(timer);
		},
	};
}
