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

/**
 * Validate a compose template against the allowlist of images and volume mounts.
 * Rejects templates that reference unknown images or mount sensitive host paths.
 */
export function validateComposeTemplate(template: string): { valid: boolean; reason?: string } {
	// Check for image references — every `image:` line must use an allowed prefix
	const imageLines = template.match(/^\s*image:\s*(.+)$/gm);
	if (imageLines) {
		for (const line of imageLines) {
			const imageRef = line.replace(/^\s*image:\s*/, '').trim().replace(/["']/g, '');
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
