/**
 * Typed configuration loaded from environment variables
 */

import { hostname } from 'os';
import type { IpPoolConfig, DkimKeyConfig, DomainProfile } from './types.js';
import { isOutboundTlsMode, OUTBOUND_TLS_MODES, type OutboundTlsMode } from './smtp/tlsPolicy.js';

export interface MtaConfig {
	/** HTTP server port */
	port: number;
	/** Inbound SMTP port for bounce processing */
	bouncePort: number;
	/** Redis connection URL */
	redisUrl: string;
	/** Shared secret for HTTP API authentication */
	apiKey: string;
	/** EHLO hostname (must match rDNS PTR record); the per-IP map falls back to this */
	ehloHostname: string;
	/**
	 * Per-IP EHLO hostname overrides (sending IP → FQDN).
	 *
	 * In a multi-IP deployment each IP needs its own PTR record, so the EHLO
	 * name announced from a given bind IP must match *that* IP's reverse DNS for
	 * FCrDNS to pass. Keys are bind IPs, values are FQDNs. IPs not listed fall
	 * back to `ehloHostname`. Empty in single-IP deployments.
	 */
	ehloHostnames: Record<string, string>;
	/** Domain for VERP return-path addresses */
	returnPathDomain: string;
	/** Convex site URL for webhook callbacks */
	convexSiteUrl: string;
	/** Shared secret for Convex webhook authentication */
	webhookSecret: string;
	/** IP pool configuration */
	ipPools: IpPoolConfig;
	/** Per-domain DKIM keys */
	dkimKeys: Record<string, DkimKeyConfig>;
	/** GroupMQ worker concurrency (parallel group processing) */
	workerConcurrency: number;
	/** Server ID for multi-instance deployments */
	serverId: string;
	/** SMTP connection pool settings */
	smtpPool: {
		maxPerHost: number;
		idleTimeoutMs: number;
		maxAgeMs: number;
	};
	/** Per-organization send rate limits */
	orgLimits: {
		defaultDailyLimit: number;
		defaultHourlyLimit: number;
	};
	/** SMTP submission port (587, STARTTLS) */
	submissionPort: number;
	/** Enable SMTP submission server */
	submissionEnabled: boolean;
	/** Implicit-TLS submission port (465, RFC 8314 §3.3 preferred transport) */
	submissionImplicitTlsPort: number;
	/** Enable the implicit-TLS (465) submission listener */
	submissionImplicitTlsEnabled: boolean;
	/** TLS cert for submission (PEM string) */
	submissionTlsCert?: string;
	/** TLS key for submission (PEM string) */
	submissionTlsKey?: string;
	/** Maximum concurrent connections per IP to the submission server */
	submissionMaxConnectionsPerIp: number;
	/** Maximum total concurrent connections to the submission server */
	submissionMaxClients: number;
	/** Failed AUTH attempts per IP within the window before further AUTH is throttled */
	submissionMaxAuthFailuresPerIp: number;
	/** Enable content pre-screening before delivery */
	contentScreeningEnabled: boolean;
	/** Maximum HTML content size in KB */
	contentMaxSizeKb: number;
	/** Max entries per daily delivery log Redis Stream */
	deliveryLogMaxLen: number;
	/** TTL in hours for delivery log streams */
	deliveryLogTtlHours: number;
	/** Max entries in the webhook dead letter queue */
	webhookDlqMaxSize: number;
	/** TLS cert for bounce SMTP server (PEM string, enables STARTTLS) */
	bounceServerTlsCert?: string;
	/** TLS key for bounce SMTP server (PEM string) */
	bounceServerTlsKey?: string;
	/** Maximum concurrent connections per IP to bounce server */
	bounceMaxConnectionsPerIp: number;
	/** Maximum total concurrent connections to bounce server */
	bounceMaxClients: number;
	/** Enable tarpit (slowdown) for suspicious connections */
	bounceTarpitEnabled: boolean;
	/** Tarpit delay in ms for suspicious connections */
	bounceTarpitDelayMs: number;
	/** Enable SPF validation for inbound email */
	inboundSpfEnabled: boolean;
	/** Enable DKIM verification (RFC 6376) for inbound email */
	inboundDkimEnabled: boolean;
	/** Enable DMARC evaluation (RFC 7489) for inbound email */
	inboundDmarcEnabled: boolean;
	/** Optional rspamd HTTP URL for content spam scoring */
	rspamdUrl?: string;
	/** Rspamd reject threshold (score above this rejects the email) */
	rspamdRejectThreshold: number;
	/** Google Postmaster API credentials JSON */
	googlePostmasterCredentials?: string;
	/** Global max SMTP connections per MX host across all instances */
	smtpPoolGlobalMaxPerHost: number;
	/**
	 * Maximum wall-clock age (ms) a message may keep being retried before the
	 * MTA gives up and emits a terminal expired-bounce. RFC 5321 §4.5.4.1
	 * recommends ~4–5 days. Measured from the *first* enqueue, so it survives
	 * defer re-queues (greylist/rate-limit/warming-cap/breaker).
	 */
	maxMessageAgeMs: number;
	/**
	 * Global outbound TLS posture for direct-MX delivery (RFC 7435/8461/9325).
	 * `opportunistic` (default) is byte-identical to the historic behaviour:
	 * encrypt when STARTTLS is offered, never fail delivery on a missing or
	 * unverifiable certificate. `require` mandates the STARTTLS upgrade;
	 * `require-verified` additionally verifies the certificate (can bounce mail
	 * to receivers with broken TLS). Per-domain overrides live in Redis.
	 *
	 * `loadConfig` always populates this; optional only so partial test-double
	 * configs and `as MtaConfig` casts need not restate it (read sites fall back
	 * to `opportunistic`, the historic default).
	 */
	outboundTlsMode?: OutboundTlsMode;
}

/**
 * Refuse to boot the submission listener without TLS material.
 *
 * RFC 8314 §3.3 + RFC 4954 §4: the submission listener must require an
 * encrypted channel before AUTH so credentials are never offered over
 * plaintext. With no cert/key the server would either run without STARTTLS
 * (plaintext AUTH) or come up broken; either way it is unsafe to start
 * silently — fail fast at config load instead.
 *
 * @throws Error when SUBMISSION_ENABLED is true but cert and/or key are absent.
 */
export function assertSubmissionTlsConfigured(
	cert: string | undefined,
	key: string | undefined
): void {
	const missing: string[] = [];
	if (!cert) missing.push('SUBMISSION_TLS_CERT');
	if (!key) missing.push('SUBMISSION_TLS_KEY');
	if (missing.length > 0) {
		throw new Error(
			`SUBMISSION_ENABLED=true requires TLS material — missing ${missing.join(' and ')}. ` +
				'Refusing to start an insecure submission listener (RFC 8314 §3.3).'
		);
	}
}

/**
 * ISP-specific sending profiles with adaptive rate limiting parameters
 */
export const ISP_PROFILES: Record<string, DomainProfile> = {
	'gmail.com': {
		defaultRate: 100,
		ceiling: 300,
		floor: 5,
		backoffFactor: 0.5,
		recoveryFactor: 1.1,
	},
	'googlemail.com': {
		defaultRate: 100,
		ceiling: 300,
		floor: 5,
		backoffFactor: 0.5,
		recoveryFactor: 1.1,
	},
	'outlook.com': {
		defaultRate: 80,
		ceiling: 200,
		floor: 5,
		backoffFactor: 0.5,
		recoveryFactor: 1.1,
	},
	'hotmail.com': {
		defaultRate: 80,
		ceiling: 200,
		floor: 5,
		backoffFactor: 0.5,
		recoveryFactor: 1.1,
	},
	'live.com': { defaultRate: 80, ceiling: 200, floor: 5, backoffFactor: 0.5, recoveryFactor: 1.1 },
	'yahoo.com': {
		defaultRate: 50,
		ceiling: 150,
		floor: 3,
		backoffFactor: 0.4,
		recoveryFactor: 1.05,
	},
	'aol.com': { defaultRate: 50, ceiling: 150, floor: 3, backoffFactor: 0.4, recoveryFactor: 1.05 },
	'ymail.com': {
		defaultRate: 50,
		ceiling: 150,
		floor: 3,
		backoffFactor: 0.4,
		recoveryFactor: 1.05,
	},
	'icloud.com': {
		defaultRate: 60,
		ceiling: 150,
		floor: 5,
		backoffFactor: 0.5,
		recoveryFactor: 1.1,
	},
	'me.com': { defaultRate: 60, ceiling: 150, floor: 5, backoffFactor: 0.5, recoveryFactor: 1.1 },
	'mac.com': { defaultRate: 60, ceiling: 150, floor: 5, backoffFactor: 0.5, recoveryFactor: 1.1 },
	__default__: { defaultRate: 30, ceiling: 100, floor: 2, backoffFactor: 0.5, recoveryFactor: 1.1 },
};

// The base warming schedule (day → daily cap) now lives in @owlat/shared so the
// MTA and the Convex warming dashboard share one source instead of forked
// copies that drifted. Re-exported for existing importers (intelligence/warming).
export { BASE_WARMING_SCHEDULE } from '@owlat/shared/warming';

/**
 * DNSBL zones to check
 */
export const DNSBL_ZONES = [
	{ zone: 'zen.spamhaus.org', name: 'Spamhaus', severity: 'critical' as const },
	{ zone: 'b.barracudacentral.org', name: 'Barracuda', severity: 'warning' as const },
	{ zone: 'bl.spamcop.net', name: 'SpamCop', severity: 'warning' as const },
];

/**
 * Validate that a string is a publicly-routable, multi-label FQDN suitable for
 * EHLO. RFC 5321 §4.1.1.1 requires the EHLO argument to be the client's fully
 * qualified domain name, and RFC 1912 §2.1 / the 2024 Gmail+Yahoo bulk-sender
 * rules require it to match the IP's PTR record. A bare hostname ('mta1'),
 * 'localhost', a raw IP literal ('203.0.113.10'), or anything with whitespace
 * can never satisfy FCrDNS, so we reject them at startup instead of silently
 * shipping mail that fails authentication.
 */
export function assertValidEhloHostname(value: string, source: string): void {
	const trimmed = value.trim();

	if (trimmed.length === 0 || /\s/.test(value)) {
		throw new Error(
			`${source} must be a hostname with no whitespace, got: ${JSON.stringify(value)}`
		);
	}
	if (trimmed === 'localhost') {
		throw new Error(`${source} must be a public FQDN, not 'localhost'`);
	}
	// Reject IPv4/IPv6 literals — EHLO must be a name, not an address.
	if (/^[0-9.]+$/.test(trimmed) || trimmed.includes(':')) {
		throw new Error(
			`${source} must be a hostname, not an IP address, got: ${JSON.stringify(value)}`
		);
	}
	// Require at least two labels (a dot) — bare hostnames like 'mta1' are not FQDNs.
	if (!trimmed.includes('.')) {
		throw new Error(
			`${source} must be a fully qualified domain name with a dot, got: ${JSON.stringify(value)}`
		);
	}
	// Each label: alphanumeric + hyphens, 1-63 chars, no leading/trailing hyphen.
	const labelOk = trimmed
		.split('.')
		.every((label) => /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/.test(label));
	if (!labelOk) {
		throw new Error(`${source} is not a valid FQDN, got: ${JSON.stringify(value)}`);
	}
}

/**
 * Resolve the EHLO hostname to announce when sending from a given bind IP.
 *
 * Returns the per-IP override from `config.ehloHostnames` when one exists for
 * the bind IP, otherwise the global `config.ehloHostname`. This is what lets a
 * multi-IP deployment present each IP's own PTR-matching name so every IP — not
 * just one — can pass FCrDNS.
 */
export function resolveEhloForIp(
	config: Pick<MtaConfig, 'ehloHostname' | 'ehloHostnames'>,
	bindIp: string
): string {
	return config.ehloHostnames[bindIp] ?? config.ehloHostname;
}

/**
 * Load and validate configuration from environment variables
 */
export function loadConfig(): MtaConfig {
	const requiredEnv = (key: string): string => {
		const value = process.env[key];
		if (!value) throw new Error(`Missing required environment variable: ${key}`);
		return value;
	};

	const optionalEnv = (key: string, defaultValue: string): string => {
		return process.env[key] ?? defaultValue;
	};

	// Parse IP pools from comma-separated env vars
	const transactionalIps = requiredEnv('IP_POOLS_TRANSACTIONAL')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const campaignIps = requiredEnv('IP_POOLS_CAMPAIGN')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

	if (transactionalIps.length === 0)
		throw new Error('IP_POOLS_TRANSACTIONAL must contain at least one IP');
	if (campaignIps.length === 0) throw new Error('IP_POOLS_CAMPAIGN must contain at least one IP');

	// EHLO hostname must be a real FQDN that can match a PTR record.
	const ehloHostname = requiredEnv('EHLO_HOSTNAME');
	assertValidEhloHostname(ehloHostname, 'EHLO_HOSTNAME');

	// Parse per-IP EHLO hostname overrides from JSON env var.
	// {"1.2.3.4":"a.example.com","5.6.7.8":"b.example.com"}
	let ehloHostnames: Record<string, string> = {};
	const ehloHostnamesRaw = process.env['EHLO_HOSTNAMES'];
	if (ehloHostnamesRaw && ehloHostnamesRaw.trim().length > 0) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(ehloHostnamesRaw);
		} catch {
			throw new Error('EHLO_HOSTNAMES must be valid JSON: {"1.2.3.4":"mail1.example.com"}');
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			throw new Error('EHLO_HOSTNAMES must be a JSON object mapping IP to hostname');
		}
		for (const [ip, name] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof name !== 'string') {
				throw new Error(`EHLO_HOSTNAMES value for ${ip} must be a string`);
			}
			assertValidEhloHostname(name, `EHLO_HOSTNAMES[${ip}]`);
			ehloHostnames[ip.trim()] = name.trim();
		}
	}

	// Parse DKIM keys from JSON env var
	let dkimKeys: Record<string, DkimKeyConfig> = {};
	const dkimKeysRaw = process.env['DKIM_KEYS'];
	if (dkimKeysRaw) {
		try {
			dkimKeys = JSON.parse(dkimKeysRaw);
		} catch {
			throw new Error(
				'DKIM_KEYS must be valid JSON: {"domain.com":{"selector":"s1","privateKey":"..."}}'
			);
		}
	}

	// Refuse to boot an insecure submission listener: when submission is enabled
	// the cert/key MUST be present so STARTTLS can be required before AUTH
	// (RFC 8314 §3.3). Otherwise the listener would advertise AUTH over plaintext
	// and credentials would be brute-forceable in the clear. Fail fast here
	// rather than starting a broken-but-not-plaintext listener (index.ts).
	const submissionEnabled = optionalEnv('SUBMISSION_ENABLED', 'false') === 'true';
	// Implicit TLS (465) reuses the same submission cert/key — it is the RFC 8314
	// §3.3-preferred transport, so a deployment may enable it alongside (or
	// instead of) the 587 STARTTLS listener.
	const submissionImplicitTlsEnabled =
		optionalEnv('SUBMISSION_IMPLICIT_TLS_ENABLED', 'false') === 'true';
	const submissionTlsCert = process.env['SUBMISSION_TLS_CERT'];
	const submissionTlsKey = process.env['SUBMISSION_TLS_KEY'];
	if (submissionEnabled || submissionImplicitTlsEnabled) {
		assertSubmissionTlsConfigured(submissionTlsCert, submissionTlsKey);
	}

	// Global outbound TLS posture. Defaults to `opportunistic` (historic
	// behaviour). Reject an unknown value at boot rather than silently falling
	// back — a typo like `require_verified` must not degrade to opportunistic.
	const outboundTlsModeRaw = optionalEnv('OUTBOUND_TLS_MODE', 'opportunistic');
	if (!isOutboundTlsMode(outboundTlsModeRaw)) {
		throw new Error(
			`OUTBOUND_TLS_MODE must be one of: ${OUTBOUND_TLS_MODES.join(', ')} — got ${JSON.stringify(outboundTlsModeRaw)}`
		);
	}
	const outboundTlsMode: OutboundTlsMode = outboundTlsModeRaw;

	return {
		port: parseInt(optionalEnv('PORT', '3100'), 10),
		bouncePort: parseInt(optionalEnv('BOUNCE_PORT', '25'), 10),
		redisUrl: optionalEnv('REDIS_URL', 'redis://localhost:6379'),
		apiKey: requiredEnv('MTA_API_KEY'),
		ehloHostname,
		ehloHostnames,
		returnPathDomain: requiredEnv('RETURN_PATH_DOMAIN'),
		convexSiteUrl: requiredEnv('CONVEX_SITE_URL'),
		webhookSecret: requiredEnv('MTA_WEBHOOK_SECRET'),
		ipPools: { transactional: transactionalIps, campaign: campaignIps },
		dkimKeys,
		workerConcurrency: parseInt(optionalEnv('WORKER_CONCURRENCY', '50'), 10),
		serverId: optionalEnv('MTA_SERVER_ID', hostname()),
		smtpPool: {
			maxPerHost: parseInt(optionalEnv('SMTP_POOL_MAX_PER_HOST', '3'), 10),
			idleTimeoutMs: parseInt(optionalEnv('SMTP_POOL_IDLE_TIMEOUT_MS', '30000'), 10),
			maxAgeMs: parseInt(optionalEnv('SMTP_POOL_MAX_AGE_MS', '300000'), 10),
		},
		orgLimits: {
			defaultDailyLimit: parseInt(optionalEnv('ORG_DEFAULT_DAILY_LIMIT', '50000'), 10),
			defaultHourlyLimit: parseInt(optionalEnv('ORG_DEFAULT_HOURLY_LIMIT', '5000'), 10),
		},
		submissionPort: parseInt(optionalEnv('SUBMISSION_PORT', '587'), 10),
		submissionEnabled,
		submissionImplicitTlsPort: parseInt(optionalEnv('SUBMISSION_IMPLICIT_TLS_PORT', '465'), 10),
		submissionImplicitTlsEnabled,
		submissionTlsCert,
		submissionTlsKey,
		submissionMaxConnectionsPerIp: parseInt(
			optionalEnv('SUBMISSION_MAX_CONNECTIONS_PER_IP', '10'),
			10
		),
		submissionMaxClients: parseInt(optionalEnv('SUBMISSION_MAX_CLIENTS', '200'), 10),
		submissionMaxAuthFailuresPerIp: parseInt(
			optionalEnv('SUBMISSION_MAX_AUTH_FAILURES_PER_IP', '10'),
			10
		),
		contentScreeningEnabled: optionalEnv('CONTENT_SCREENING_ENABLED', 'true') === 'true',
		contentMaxSizeKb: parseInt(optionalEnv('CONTENT_MAX_SIZE_KB', '500'), 10),
		deliveryLogMaxLen: parseInt(optionalEnv('DELIVERY_LOG_MAX_LEN', '100000'), 10),
		deliveryLogTtlHours: parseInt(optionalEnv('DELIVERY_LOG_TTL_HOURS', '72'), 10),
		webhookDlqMaxSize: parseInt(optionalEnv('WEBHOOK_DLQ_MAX_SIZE', '10000'), 10),
		bounceServerTlsCert: process.env['BOUNCE_TLS_CERT'],
		bounceServerTlsKey: process.env['BOUNCE_TLS_KEY'],
		bounceMaxConnectionsPerIp: parseInt(optionalEnv('BOUNCE_MAX_CONNECTIONS_PER_IP', '10'), 10),
		bounceMaxClients: parseInt(optionalEnv('BOUNCE_MAX_CLIENTS', '200'), 10),
		bounceTarpitEnabled: optionalEnv('BOUNCE_TARPIT_ENABLED', 'true') === 'true',
		bounceTarpitDelayMs: parseInt(optionalEnv('BOUNCE_TARPIT_DELAY_MS', '5000'), 10),
		inboundSpfEnabled: optionalEnv('INBOUND_SPF_ENABLED', 'true') === 'true',
		inboundDkimEnabled: optionalEnv('INBOUND_DKIM_ENABLED', 'true') === 'true',
		inboundDmarcEnabled: optionalEnv('INBOUND_DMARC_ENABLED', 'true') === 'true',
		rspamdUrl: process.env['RSPAMD_URL'],
		rspamdRejectThreshold: parseFloat(optionalEnv('RSPAMD_REJECT_THRESHOLD', '15')),
		googlePostmasterCredentials: process.env['GOOGLE_POSTMASTER_CREDENTIALS'],
		smtpPoolGlobalMaxPerHost: parseInt(optionalEnv('SMTP_POOL_GLOBAL_MAX_PER_HOST', '10'), 10),
		// Default: 4 days (RFC 5321 §4.5.4.1 recommends 4–5 days before giving up).
		maxMessageAgeMs: parseInt(
			optionalEnv('MAX_MESSAGE_AGE_MS', String(4 * 24 * 60 * 60 * 1000)),
			10
		),
		outboundTlsMode,
	};
}
