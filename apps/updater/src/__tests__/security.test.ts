import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
	isRateLimited,
	isValidIPv4,
	parseReleaseVersionFromTemplate,
	safeCompare,
	validateComposeTemplate,
	__resetRateLimits,
} from '../security.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('safeCompare', () => {
	it('is true for equal strings', () => {
		expect(safeCompare('s3cret-value', 's3cret-value')).toBe(true);
	});

	it('is false for different strings (including different lengths)', () => {
		expect(safeCompare('s3cret-value', 's3cret-valu')).toBe(false);
		expect(safeCompare('a', 'completely-different')).toBe(false);
		expect(safeCompare('', 'x')).toBe(false);
	});

	it('is true for two empty strings', () => {
		expect(safeCompare('', '')).toBe(true);
	});
});

describe('isValidIPv4', () => {
	it('accepts well-formed addresses', () => {
		expect(isValidIPv4('192.168.1.1')).toBe(true);
		expect(isValidIPv4('0.0.0.0')).toBe(true);
		expect(isValidIPv4('255.255.255.255')).toBe(true);
	});

	it('rejects out-of-range octets', () => {
		expect(isValidIPv4('256.0.0.1')).toBe(false);
		expect(isValidIPv4('999.1.1.1')).toBe(false);
	});

	it('rejects leading-zero octets (defence against octal parsing surprises)', () => {
		expect(isValidIPv4('192.168.01.1')).toBe(false);
		expect(isValidIPv4('010.0.0.1')).toBe(false);
	});

	it('rejects non-IPv4 shapes', () => {
		expect(isValidIPv4('192.168.1')).toBe(false);
		expect(isValidIPv4('1.2.3.4.5')).toBe(false);
		expect(isValidIPv4('::1')).toBe(false);
		expect(isValidIPv4('not-an-ip')).toBe(false);
		expect(isValidIPv4('')).toBe(false);
	});
});

describe('isRateLimited', () => {
	beforeEach(() => __resetRateLimits());

	it('allows up to maxRequests within the window, then blocks', () => {
		// maxRequests = 2 → 1st and 2nd allowed, 3rd blocked.
		expect(isRateLimited('update', 2, 60_000)).toBe(false);
		expect(isRateLimited('update', 2, 60_000)).toBe(false);
		expect(isRateLimited('update', 2, 60_000)).toBe(true);
	});

	it('tracks endpoints independently', () => {
		expect(isRateLimited('a', 1, 60_000)).toBe(false);
		expect(isRateLimited('a', 1, 60_000)).toBe(true);
		// A different endpoint has its own counter.
		expect(isRateLimited('b', 1, 60_000)).toBe(false);
	});

	it('resets after the window elapses', () => {
		// A zero-length window means every call starts a fresh bucket.
		expect(isRateLimited('zero', 1, 0)).toBe(false);
		expect(isRateLimited('zero', 1, 0)).toBe(false);
	});
});

describe('validateComposeTemplate', () => {
	const okCompose = `services:
  web:
    image: ghcr.io/wolvesdotink/web:0.2.0
  convex:
    image: ghcr.io/get-convex/convex-backend:latest
  redis:
    image: redis:7
    volumes:
      - owlat-data:/data
      - /opt/owlat/.env:/run/secrets/env:ro
`;

	it('accepts a template using only allowlisted images and safe mounts', () => {
		expect(validateComposeTemplate(okCompose)).toEqual({ valid: true });
	});

	it('rejects an image outside the allowlist', () => {
		const bad = `services:
  evil:
    image: docker.io/attacker/miner:latest
`;
		const result = validateComposeTemplate(bad);
		expect(result.valid).toBe(false);
		expect(result.reason).toContain('Disallowed image');
	});

	// Regression: the shipped VPS compose template is what update.post.ts forwards
	// here for validation, so every image it references must be allowlisted.
	// (goacme/lego, tecnativa/docker-socket-proxy and ollama/ollama had drifted
	// out of ALLOWED_IMAGE_PREFIXES, which would have aborted any self-update.)
	it('accepts the shipped VPS compose template (vpsComposeImagesAreAllowed)', () => {
		const template = readFileSync(
			resolve(REPO_ROOT, 'infra/templates/docker-compose.vps.yml'),
			'utf-8'
		);
		expect(validateComposeTemplate(template)).toEqual({ valid: true });
	});

	// Regression (the 500-on-update incident): the template the update routes
	// ACTUALLY forward is the release one — `docker-compose-<v>.yml`, which
	// scripts/gen-release-compose.sh generates from the root docker-compose.yml.
	// Only the VPS template was pinned here, so five images the root compose
	// ships (caddy, alpine, the Convex dashboard, and the two locally built
	// sidecars) were never allowlisted and every in-app update on a release
	// install died with `Disallowed image: caddy:…`.
	//
	// Validating the generator's INPUT is equivalent to validating its output
	// for this policy: the script rewrites `ghcr.io/wolvesdotink/*` tags only
	// (adding `:<version>@sha256:<digest>`, which still matches the org
	// prefix) and leaves every other image line byte-identical — the property
	// scripts/__tests__/gen-release-compose.test.ts pins from the other side.
	it('accepts the root compose the release template is generated from (releaseComposeImagesAreAllowed)', () => {
		const template = readFileSync(resolve(REPO_ROOT, 'docker-compose.yml'), 'utf-8');
		expect(validateComposeTemplate(template)).toEqual({ valid: true });
	});

	it.each([
		['/etc/shadow', '/etc/shadow:/x'],
		['/etc/passwd', '/etc/passwd:/x'],
		['/root/.ssh', '/root/.ssh:/x'],
		['/proc', '/proc:/host/proc'],
		['/sys', '/sys:/host/sys'],
		['/dev', '/dev:/host/dev'],
	])('rejects dangerous host mount %s', (_label, mount) => {
		const bad = `services:
  web:
    image: ghcr.io/wolvesdotink/web:latest
    volumes:
      - ${mount}
`;
		const result = validateComposeTemplate(bad);
		expect(result.valid).toBe(false);
		expect(result.reason).toContain('Dangerous volume mount');
	});

	it('rejects privileged mode', () => {
		const bad = `services:
  web:
    image: ghcr.io/wolvesdotink/web:latest
    privileged: true
`;
		expect(validateComposeTemplate(bad)).toMatchObject({
			valid: false,
			reason: expect.stringContaining('Privileged'),
		});
	});

	it('rejects SYS_ADMIN capability', () => {
		const bad = `services:
  web:
    image: ghcr.io/wolvesdotink/web:latest
    cap_add:
      - SYS_ADMIN
`;
		expect(validateComposeTemplate(bad)).toMatchObject({
			valid: false,
			reason: expect.stringContaining('SYS_ADMIN'),
		});
	});

	it.each(['pid', 'network_mode'])('rejects host %s mode', (key) => {
		const bad = `services:
  web:
    image: ghcr.io/wolvesdotink/web:latest
    ${key}: host
`;
		const result = validateComposeTemplate(bad);
		expect(result.valid).toBe(false);
		expect(result.reason).toContain('Host PID/network mode');
	});

	it('allows named volumes that merely contain a colon', () => {
		const named = `services:
  web:
    image: ghcr.io/wolvesdotink/web:latest
    volumes:
      - named-vol:/data
`;
		expect(validateComposeTemplate(named)).toEqual({ valid: true });
	});
});

describe('parseReleaseVersionFromTemplate', () => {
	it('reads the version from a tag-pinned web image', () => {
		const template = 'services:\n  web:\n    image: ghcr.io/wolvesdotink/web:1.2.3\n';
		expect(parseReleaseVersionFromTemplate(template)).toBe('1.2.3');
	});

	it('reads the version from the digest-pinned form the release template ships', () => {
		const template = `services:
  web:
    image: ghcr.io/wolvesdotink/web:0.4.17@sha256:${'a'.repeat(64)}
  mta:
    image: ghcr.io/wolvesdotink/mta:0.4.17@sha256:${'b'.repeat(64)}
`;
		expect(parseReleaseVersionFromTemplate(template)).toBe('0.4.17');
	});

	it('reads a prerelease version', () => {
		const template = 'services:\n  web:\n    image: "ghcr.io/wolvesdotink/web:1.2.3-rc.1"\n';
		expect(parseReleaseVersionFromTemplate(template)).toBe('1.2.3-rc.1');
	});

	it('returns null when the web image carries no concrete version', () => {
		const template =
			'services:\n  web:\n    image: ghcr.io/wolvesdotink/web:${OWLAT_VERSION:-dev}\n';
		expect(parseReleaseVersionFromTemplate(template)).toBeNull();
	});

	it('ignores versions pinned on other services', () => {
		const template = 'services:\n  mta:\n    image: ghcr.io/wolvesdotink/mta:9.9.9\n';
		expect(parseReleaseVersionFromTemplate(template)).toBeNull();
	});
});
