import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Guards the production-hardening of the root docker-compose.yml (the stack most
 * self-hosters actually run). No `docker compose config` harness runs in CI, so
 * these are string assertions against the checked-in compose file — they fail if
 * any of the backported-from-VPS protections regress:
 *
 *   • Registry: every Owlat image points at ghcr.io/wolvesdotink (the
 *     ${repository_owner}-derived prefix), never the ghcr.io/owlat placeholder,
 *     and is pinned via ${OWLAT_VERSION:-dev} rather than the mutable :latest.
 *   • Updater: drives Docker through the read-only docker-socket-proxy; the raw
 *     read-write /var/run/docker.sock is never mounted into a workload.
 *   • ClamAV: profile-gated behind the `clamav` profile (scan.files), with the
 *     MTA's dependency on it required:false so the MTA boots without it.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const compose = readFileSync(resolve(REPO_ROOT, 'docker-compose.yml'), 'utf8');

/** Slice one top-level service block (`  name:` … up to the next `  name:`). */
function serviceBlock(name: string): string {
	const start = compose.indexOf(`\n  ${name}:\n`);
	expect(start, `service ${name} not found in docker-compose.yml`).toBeGreaterThanOrEqual(0);
	const after = compose.slice(start + 1);
	const next = after.search(/\n {2}[a-z][a-z0-9_-]*:\n/);
	return next === -1 ? after : after.slice(0, next);
}

const OWLAT_IMAGE_SERVICES = ['web', 'mta', 'updater', 'convex-deploy', 'imap', 'mail-sync'];

describe('docker-compose.yml — image registry', () => {
	it('contains no ghcr.io/owlat placeholder references', () => {
		// The repo is moving to the wolvesdotink org; the owlat placeholder must
		// not creep back in (matches the installer-entrypoint + docs guards).
		expect(compose).not.toMatch(/ghcr\.io\/owlat\b/);
	});

	it('points every Owlat image at ghcr.io/wolvesdotink', () => {
		for (const svc of OWLAT_IMAGE_SERVICES) {
			expect(serviceBlock(svc), `${svc} image`).toMatch(
				new RegExp(`image:\\s*ghcr\\.io/wolvesdotink/${svc}:`),
			);
		}
	});

	it('pins images via ${OWLAT_VERSION} default, never the mutable :latest', () => {
		// No Owlat (or local code-worker) image may default to :latest…
		expect(compose).not.toMatch(/ghcr\.io\/wolvesdotink\/[a-z0-9-]+:\$\{OWLAT_VERSION:-latest\}/);
		expect(compose).not.toMatch(/ghcr\.io\/wolvesdotink\/[a-z0-9-]+:latest\b/);
		expect(compose).not.toMatch(/owlat-code-worker:\$\{OWLAT_VERSION:-latest\}/);
		// …and each registry image resolves through an OWLAT_VERSION env default.
		for (const svc of OWLAT_IMAGE_SERVICES) {
			expect(serviceBlock(svc), `${svc} pin`).toMatch(
				new RegExp(`image:\\s*ghcr\\.io/wolvesdotink/${svc}:\\$\\{OWLAT_VERSION:-dev\\}`),
			);
		}
	});
});

describe('docker-compose.yml — updater / docker socket', () => {
	it('never mounts the raw read-write docker socket into a workload', () => {
		// A bind mount of the socket WITHOUT a `:ro` suffix is read-write — that
		// hands the mounting container effective root on the host.
		expect(compose).not.toMatch(/\/var\/run\/docker\.sock:\/var\/run\/docker\.sock(?!:ro)/);
	});

	it('runs a docker-socket-proxy that mounts the socket read-only', () => {
		const proxy = serviceBlock('docker-socket-proxy');
		expect(proxy).toMatch(/image:\s*tecnativa\/docker-socket-proxy:/);
		expect(proxy).toMatch(/\/var\/run\/docker\.sock:\/var\/run\/docker\.sock:ro/);
	});

	it('makes the updater reach Docker through the proxy, not the raw socket', () => {
		const updater = serviceBlock('updater');
		expect(updater).toMatch(/DOCKER_HOST:\s*tcp:\/\/docker-socket-proxy:2375/);
		expect(updater).toMatch(/depends_on:\s*\n\s*-\s*docker-socket-proxy/);
		// The updater must not bind-mount the socket any more (only the proxy may).
		expect(updater).not.toMatch(/-\s*\/var\/run\/docker\.sock/);
	});

	it('isolates the Docker socket proxy on an internal-only network', () => {
		// The privileged Docker API must be unreachable from any internet-facing
		// tier: docker-proxy is internal:true and only the proxy + updater attach.
		expect(compose).toMatch(/^networks:\s*$/m);
		expect(compose).toMatch(/^ {2}docker-proxy:\s*\n {4}internal:\s*true\s*$/m);

		// The proxy attaches to docker-proxy ONLY (never the shared default net).
		const proxy = serviceBlock('docker-socket-proxy');
		expect(proxy).toMatch(/networks:\s*\n\s*-\s*docker-proxy/);
		expect(proxy).not.toMatch(/-\s*default\b/);

		// The updater bridges default (so web→updater works) AND docker-proxy.
		const updater = serviceBlock('updater');
		expect(updater).toMatch(/networks:\s*\n\s*-\s*default\s*\n\s*-\s*docker-proxy/);
	});

	it('keeps every other service off the docker-proxy network', () => {
		// Only docker-socket-proxy and updater may carry `- docker-proxy`; any
		// other service joining it would re-expose the Docker API.
		const proxyMembers = (compose.match(/^\s*-\s*docker-proxy\s*$/gm) ?? []).length;
		expect(proxyMembers).toBe(2);
	});
});

describe('docker-compose.yml — ClamAV profile gate', () => {
	it('profile-gates clamav behind the clamav profile', () => {
		const clamav = serviceBlock('clamav');
		expect(clamav).toMatch(/profiles:\s*\n(?:\s*#[^\n]*\n)*\s*-\s*clamav/);
	});

	it('keeps the MTA dependency on clamav required:false', () => {
		// So the MTA still boots (attachment scanning fail-open) when clamd is off.
		const mta = serviceBlock('mta');
		const clamavDep = mta.slice(mta.indexOf('clamav:'));
		expect(mta).toMatch(/clamav:/);
		expect(clamavDep).toMatch(/required:\s*false/);
	});
});

describe('docker-compose.yml — capability hardening', () => {
	it('drops privileges broadly (no-new-privileges + cap_drop)', () => {
		expect((compose.match(/no-new-privileges:true/g) ?? []).length).toBeGreaterThanOrEqual(10);
		expect((compose.match(/cap_drop:/g) ?? []).length).toBeGreaterThanOrEqual(8);
	});

	it('runs the web tier read-only with a tmpfs /tmp', () => {
		const web = serviceBlock('web');
		expect(web).toMatch(/read_only:\s*true/);
		expect(web).toMatch(/tmpfs:\s*\n\s*-\s*\/tmp/);
	});
});
