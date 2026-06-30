export interface MailSyncConfig {
	/** HTTP port for the internal /send + /test + /health endpoints. */
	port: number;
	listenAddress: string;
	convexUrl: string;
	convexAdminKey: string;
	/** Bearer token Convex must present on /send and /test (MAIL_SYNC_API_KEY). */
	apiKey: string;
	/** How often the reconcile loop syncs the live connection set with Convex. */
	reconcileIntervalMs: number;
	/** How often each account's non-INBOX folders are polled (INBOX is real-time via IDLE). */
	folderPollIntervalMs: number;
	/** Messages per descending UID batch during a historical migration backfill. */
	backfillBatchSize: number;
	/**
	 * Origins /send may fetch rawEmlUrl from. Always includes the CONVEX_URL
	 * origin; MAIL_SYNC_FETCH_ORIGINS (comma-separated) adds more — needed
	 * when Convex storage URLs are minted on the PUBLIC convex origin while
	 * the worker talks to the internal one.
	 */
	allowedFetchOrigins: string[];
}

export function loadConfig(): MailSyncConfig {
	const convexUrl = process.env['CONVEX_URL'] ?? '';
	const convexAdminKey = process.env['CONVEX_ADMIN_KEY'] ?? '';
	const apiKey = process.env['MAIL_SYNC_API_KEY'] ?? '';

	if (!convexUrl) throw new Error('CONVEX_URL is required');
	if (!convexAdminKey) throw new Error('CONVEX_ADMIN_KEY is required');
	if (!apiKey) throw new Error('MAIL_SYNC_API_KEY is required');

	return {
		port: parseInt(process.env['MAIL_SYNC_PORT'] ?? '3200', 10),
		listenAddress: process.env['MAIL_SYNC_LISTEN'] ?? '0.0.0.0',
		convexUrl,
		convexAdminKey,
		apiKey,
		reconcileIntervalMs: parseInt(process.env['MAIL_SYNC_RECONCILE_MS'] ?? '30000', 10),
		folderPollIntervalMs: parseInt(process.env['MAIL_SYNC_FOLDER_POLL_MS'] ?? `${5 * 60 * 1000}`, 10),
		backfillBatchSize: parseInt(process.env['MAIL_SYNC_BACKFILL_BATCH'] ?? '200', 10),
		allowedFetchOrigins: [
			new URL(convexUrl).origin,
			...(process.env['MAIL_SYNC_FETCH_ORIGINS'] ?? '')
				.split(',')
				.map((o) => o.trim())
				.filter(Boolean)
				.map((o) => new URL(o).origin),
		],
	};
}
