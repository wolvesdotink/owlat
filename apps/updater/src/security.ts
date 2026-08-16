/**
 * Pure security policy for the updater sidecar.
 *
 * The updater exposes a privileged HTTP surface (it can rewrite the host's
 * docker-compose.yml, attach floating IPs, and rotate secrets), so its
 * validation logic is the single most security-sensitive part of the app.
 * Kept in its own module — free of HTTP/process side effects — so every gate
 * can be exercised in isolation by the unit tests in `__tests__/security.test.ts`.
 * `index.ts` wires these into the request handlers.
 */
import { timingSafeEqual, createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';
import {
	FEATURE_FLAGS,
	hasFeatureFlagDefinition,
	isPluginFeatureFlagKey,
	type FeatureFlagKey,
	type FeatureFlagState,
} from '@owlat/shared/featureFlags';

/** Extract a human-readable message from an unknown caught throw. */
export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === 'object' && err !== null && 'message' in err) {
		return String((err as { message: unknown }).message);
	}
	return String(err);
}

// ── Allowed Docker images that may appear in compose templates ──
// Any image not in this list will cause the compose template to be rejected.
//
// This MUST cover every image emitted by infra/templates/docker-compose.vps.yml
// (and the setup-CLI compose override), since update.post.ts forwards that
// template here for validation. The vpsComposeImagesAreAllowed test in
// __tests__/security.test.ts asserts the two never drift.
export const ALLOWED_IMAGE_PREFIXES = [
	'ghcr.io/get-convex/convex-backend',
	'ghcr.io/wolvesdotink/', // canonical org — emitted by the root docker-compose.yml, the VPS template, and gen-release-compose.sh
	'redis:',
	'clamav/clamav:',
	'goacme/lego:', // ACME/Let's Encrypt cert issuance
	'tecnativa/docker-socket-proxy:', // least-privilege docker socket proxy
	'ollama/ollama:', // optional local LLM provider
	'busybox:', // setup-CLI override marker service
];

// ── Rate limiting ──
const rateLimits: Record<string, { count: number; resetAt: number }> = {};

export function isRateLimited(endpoint: string, maxRequests: number, windowMs: number): boolean {
	const now = Date.now();
	const entry = rateLimits[endpoint];

	if (!entry || now >= entry.resetAt) {
		rateLimits[endpoint] = { count: 1, resetAt: now + windowMs };
		return false;
	}

	entry.count++;
	return entry.count > maxRequests;
}

/** Test-only: clear the in-memory rate-limit state between cases. */
export function __resetRateLimits(): void {
	for (const key of Object.keys(rateLimits)) delete rateLimits[key];
}

/**
 * Timing-safe comparison of two secret strings.
 * Prevents timing attacks that could leak the secret byte-by-byte.
 */
export function safeCompare(a: string, b: string): boolean {
	// Hash both values to ensure equal length for timingSafeEqual
	const hashA = createHash('sha256').update(a).digest();
	const hashB = createHash('sha256').update(b).digest();
	return timingSafeEqual(hashA, hashB);
}

/**
 * Validate an IPv4 address strictly.
 * Uses Node's built-in net.isIPv4() and additionally checks each octet is 0-255.
 */
export function isValidIPv4(ip: string): boolean {
	if (!isIPv4(ip)) return false;

	// Double-check octets are in valid range (net.isIPv4 should handle this, but defense-in-depth)
	const octets = ip.split('.');
	if (octets.length !== 4) return false;

	return octets.every((octet) => {
		const num = parseInt(octet, 10);
		return num >= 0 && num <= 255 && String(num) === octet; // Reject leading zeros like "01"
	});
}

// ── Hardened .env line-rewriter (shared by /rotate-env and /apply-profiles) ──

type EnvRewriteResult = { ok: true; content: string } | { ok: false; reason: string };

const ENV_KEY_SHAPE = /^[A-Z][A-Z0-9_]*$/;
// oxlint-disable-next-line no-control-regex -- intentional: the NUL byte is exactly what we reject
const ILLEGAL_ENV_VALUE = /[\r\n\x00]/;

/**
 * Rewrite `KEY=value` assignments in a `.env` file's content line-by-line,
 * preserving comments and ordering. The caller passes an explicit per-endpoint
 * key allowlist — /rotate-env keeps its five secret keys, /apply-profiles may
 * touch only COMPOSE_PROFILES — and every value is rejected on CR/LF/NUL so a
 * rewrite can never inject extra env lines. Keys absent from the file are
 * skipped unless `appendMissing` is set (idempotent: a second identical rewrite
 * is a no-op).
 */
export function applyEnvUpdates(
	content: string,
	updates: Record<string, string>,
	allowedKeys: readonly string[],
	opts: { appendMissing?: boolean } = {}
): EnvRewriteResult {
	const entries = Object.entries(updates);
	for (const [key, value] of entries) {
		if (!allowedKeys.includes(key)) {
			return { ok: false, reason: `Env key not in allowlist: ${key}` };
		}
		if (!ENV_KEY_SHAPE.test(key)) {
			return { ok: false, reason: `Malformed env key: ${key}` };
		}
		if (ILLEGAL_ENV_VALUE.test(value)) {
			return { ok: false, reason: `Value contains illegal character for: ${key}` };
		}
	}

	const seen = new Set<string>();
	const lines = content.split('\n').map((line) => {
		for (const [key, value] of entries) {
			if (line.startsWith(`${key}=`)) {
				seen.add(key);
				return `${key}=${value}`;
			}
		}
		return line;
	});

	if (opts.appendMissing) {
		const missing = entries.filter(([key]) => !seen.has(key));
		if (missing.length > 0) {
			// Keep the file's final newline in place: append before a trailing
			// empty segment when there is one, and always end with a newline.
			if (lines[lines.length - 1] === '') lines.pop();
			for (const [key, value] of missing) lines.push(`${key}=${value}`);
			lines.push('');
		}
	}

	return { ok: true, content: lines.join('\n') };
}

// ── Flag-snapshot validation for /apply-profiles ──

// Core registry (~40 keys) + the 128-plugin ceiling, with headroom.
const MAX_FLAG_SNAPSHOT_KEYS = 256;

/**
 * Validate the resolved flag snapshot POSTed to /apply-profiles against the
 * registry: a plain object of booleans whose keys are either core-registered
 * flags or plugin-shaped keys (mirrored for the CLI, ignored by profile
 * derivation since the updater carries no plugin registry). Profiles are then
 * derived server-side from this snapshot — the caller can never smuggle an
 * arbitrary COMPOSE_PROFILES string.
 */
export function validateFlagSnapshot(
	value: unknown
): { ok: true; flags: FeatureFlagState } | { ok: false; reason: string } {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return { ok: false, reason: 'flags must be an object mapping flag keys to booleans' };
	}
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > MAX_FLAG_SNAPSHOT_KEYS) {
		return { ok: false, reason: 'Too many flag keys' };
	}
	const flags: FeatureFlagState = {};
	for (const [key, flagValue] of entries) {
		if (!hasFeatureFlagDefinition(FEATURE_FLAGS, key) && !isPluginFeatureFlagKey(key)) {
			return { ok: false, reason: `Unknown feature flag: ${key}` };
		}
		if (typeof flagValue !== 'boolean') {
			return { ok: false, reason: `Flag value must be a boolean: ${key}` };
		}
		flags[key as FeatureFlagKey] = flagValue;
	}
	return { ok: true, flags };
}

/**
 * Validate a compose template against the allowlist of images and volume mounts.
 * Rejects templates that reference unknown images or mount sensitive host paths.
 */
export function validateComposeTemplate(template: string): { valid: boolean; reason?: string } {
	// Check for image references — every `image:` line must use an allowed prefix
	const imageLines = template.match(/^\s*image:\s*(.+)$/gm);
	if (imageLines) {
		for (const line of imageLines) {
			const imageRef = line
				.replace(/^\s*image:\s*/, '')
				.trim()
				.replace(/["']/g, '');
			const isAllowed = ALLOWED_IMAGE_PREFIXES.some((prefix) => imageRef.startsWith(prefix));
			if (!isAllowed) {
				return { valid: false, reason: `Disallowed image: ${imageRef}` };
			}
		}
	}

	// Block dangerous volume mounts. The directory patterns match both the bare
	// path and any sub-path ("/proc" and "/proc/foo") — a bare "/proc" mount is
	// at least as dangerous as a sub-mount, so requiring a trailing slash would
	// leave a bypass.
	const DANGEROUS_MOUNT_PATTERNS = [
		/\/etc\/shadow/,
		/\/etc\/passwd/,
		/\/root(\/|$)/,
		/\/proc(\/|$)/,
		/\/sys(\/|$)/,
		/\/dev(\/|$)/,
	];

	const volumeLines = template.match(/^\s*-\s*["']?([^"'\n]+)["']?\s*$/gm);
	if (volumeLines) {
		for (const line of volumeLines) {
			const mount = line.replace(/^\s*-\s*["']?/, '').replace(/["']?\s*$/, '');
			// Only check host:container path mounts (not named volumes)
			if (mount.includes(':') && mount.startsWith('/')) {
				const hostPath = mount.split(':')[0] ?? '';
				for (const pattern of DANGEROUS_MOUNT_PATTERNS) {
					if (pattern.test(hostPath)) {
						return { valid: false, reason: `Dangerous volume mount: ${hostPath}` };
					}
				}
			}
		}
	}

	// Block privileged mode
	if (/privileged:\s*true/i.test(template)) {
		return { valid: false, reason: 'Privileged mode is not allowed' };
	}

	// Block cap_add with dangerous capabilities
	if (/cap_add:[\s\S]*?SYS_ADMIN/i.test(template)) {
		return { valid: false, reason: 'SYS_ADMIN capability is not allowed' };
	}

	// Block pid/network host mode
	if (/(?:pid|network_mode):\s*["']?host["']?/i.test(template)) {
		return { valid: false, reason: 'Host PID/network mode is not allowed' };
	}

	return { valid: true };
}
