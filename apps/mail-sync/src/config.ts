import {
	readIntEnv,
	TCP_PORT_RANGE,
	TIMER_DELAY_MS_RANGE,
	type IntEnvOptions,
} from '@owlat/shared/nodeEnv';
import { ConvexHttpClient } from 'convex/browser';

export interface MailSyncConfig {
	/** HTTP port for the internal /send + /test + /health endpoints. */
	port: number;
	listenAddress: string;
	convexUrl: string;
	/**
	 * Origin serving the deployment's HTTP ACTIONS, which is where the raw `.eml`
	 * upload lives — a function-call body is capped at 16 MiB and a message is
	 * not. Self-hosted Convex serves them both on their own port and under
	 * `/http` on the API port, so the default needs no new deployment variable;
	 * `CONVEX_SITE_URL` overrides it where the two are split.
	 */
	convexSiteUrl: string;
	convexAdminKey: string;
	/** Bearer token Convex must present on /send and /test (MAIL_SYNC_API_KEY). */
	apiKey: string;
	/** How often the reconcile loop syncs the live connection set with Convex. */
	reconcileIntervalMs: number;
	/** How often each account's non-INBOX folders are polled (INBOX is real-time via IDLE). */
	folderPollIntervalMs: number;
	/**
	 * How often the INBOX is polled for new mail on its own, as a floor under
	 * IDLE. IDLE only runs while the connection has nothing else to do, and a
	 * busy account can starve it for good.
	 */
	inboxPollIntervalMs: number;
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

/** One configuration key that cannot be used, and the form it expects. */
export interface MailSyncConfigIssue {
	key: string;
	message: string;
}

/**
 * Every invalid mail-sync configuration key, reported together so an operator
 * fixes them in one pass instead of one restart per key. Messages name the key
 * and the expected form; they never echo a URL or secret value.
 */
export class MailSyncConfigError extends Error {
	override readonly name = 'MailSyncConfigError';

	constructor(readonly issues: readonly MailSyncConfigIssue[]) {
		super(
			`Invalid mail-sync configuration (${issues.length} ${issues.length === 1 ? 'problem' : 'problems'}):\n` +
				issues.map((issue) => `  - ${issue.message}`).join('\n')
		);
	}
}

/**
 * The origin of an absolute http(s) URL, or undefined. The value is never put
 * in an error: a URL can carry credentials, and Node's own `Invalid URL` error
 * keeps the input on its `input` property.
 */
function httpOrigin(raw: string): string | undefined {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return undefined;
	}
	return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
}

const URL_FORM = 'an absolute http(s) URL, e.g. https://convex.example.com';

/**
 * Why the Convex client would refuse `url` as a deployment address, or
 * undefined if it accepts it. The client's own constructor is the check (it
 * validates synchronously and opens no connection), so this cannot drift from
 * the SDK; its error is dropped because it quotes the URL, credentials included.
 */
function convexDeploymentUrlProblem(url: string): string | undefined {
	try {
		void new ConvexHttpClient(url, { logger: false });
		return undefined;
	} catch {
		if (url.endsWith('.convex.site')) {
			return 'CONVEX_URL must be the deployment API address (*.convex.cloud), not the HTTP actions host (*.convex.site)';
		}
		return `CONVEX_URL is not a deployment address the Convex client accepts; it must be ${URL_FORM}`;
	}
}

/**
 * Read and validate the worker's configuration. Runs before any side effect
 * (Convex client, IMAP connections, HTTP server) and throws one
 * `MailSyncConfigError` listing every invalid key.
 */
export function loadConfig(): MailSyncConfig {
	const env = process.env;
	const issues: MailSyncConfigIssue[] = [];
	const fail = (key: string, message: string) => issues.push({ key, message });

	const required = (key: string): string => {
		const value = env[key] ?? '';
		if (!value) fail(key, `${key} is required`);
		return value;
	};
	const int = (key: string, options: IntEnvOptions): number => {
		try {
			return readIntEnv(env, key, options);
		} catch (err) {
			fail(key, err instanceof Error ? err.message : `${key} must be an integer`);
			return options.default;
		}
	};

	const convexUrl = required('CONVEX_URL');
	const convexAdminKey = required('CONVEX_ADMIN_KEY');
	const apiKey = required('MAIL_SYNC_API_KEY');

	const convexOrigin = convexUrl ? httpOrigin(convexUrl) : undefined;
	if (convexUrl && convexOrigin === undefined) {
		fail('CONVEX_URL', `CONVEX_URL must be ${URL_FORM}`);
	} else if (convexUrl) {
		const problem = convexDeploymentUrlProblem(convexUrl);
		if (problem) fail('CONVEX_URL', problem);
	}

	const siteUrlOverride = env['CONVEX_SITE_URL'];
	if (siteUrlOverride && httpOrigin(siteUrlOverride) === undefined) {
		fail('CONVEX_SITE_URL', `CONVEX_SITE_URL must be ${URL_FORM}`);
	}

	const fetchOrigins: string[] = [];
	const fetchEntries = (env['MAIL_SYNC_FETCH_ORIGINS'] ?? '')
		.split(',')
		.map((o) => o.trim())
		.filter(Boolean);
	for (const [index, entry] of fetchEntries.entries()) {
		const origin = httpOrigin(entry);
		if (origin === undefined) {
			fail(
				'MAIL_SYNC_FETCH_ORIGINS',
				`MAIL_SYNC_FETCH_ORIGINS entry ${index + 1} must be ${URL_FORM}`
			);
		} else {
			fetchOrigins.push(origin);
		}
	}

	const config: MailSyncConfig = {
		port: int('MAIL_SYNC_PORT', { default: 3200, ...TCP_PORT_RANGE }),
		listenAddress: env['MAIL_SYNC_LISTEN'] ?? '0.0.0.0',
		convexUrl,
		convexSiteUrl: (siteUrlOverride || `${convexUrl.replace(/\/+$/, '')}/http`).replace(/\/+$/, ''),
		convexAdminKey,
		apiKey,
		reconcileIntervalMs: int('MAIL_SYNC_RECONCILE_MS', {
			default: 30_000,
			...TIMER_DELAY_MS_RANGE,
		}),
		folderPollIntervalMs: int('MAIL_SYNC_FOLDER_POLL_MS', {
			default: 5 * 60 * 1000,
			...TIMER_DELAY_MS_RANGE,
		}),
		inboxPollIntervalMs: int('MAIL_SYNC_INBOX_POLL_MS', {
			default: 60 * 1000,
			...TIMER_DELAY_MS_RANGE,
		}),
		backfillBatchSize: int('MAIL_SYNC_BACKFILL_BATCH', { default: 200, min: 1 }),
		allowedFetchOrigins: convexOrigin ? [convexOrigin, ...fetchOrigins] : fetchOrigins,
	};

	if (issues.length > 0) throw new MailSyncConfigError(issues);
	return config;
}
