import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// The one-liner installer entrypoints (install.sh + scripts/owlat) are pure bash
// and aren't exercised by any runtime test, so these static guards lock the
// "installer-config-preflight" fixes against regression:
//   1. defaults point at the future canonical home wolvesdotink/owlat (and no
//      placeholder 'owlat/owlat' / 'ghcr.io/owlat' org leaks back in),
//   2. the host config file is bind-mounted into the container with --config
//      rewritten to the in-container path (the host path is invisible inside it),
//   3. install.sh checks the docker DAEMON is reachable, not just the CLI,
//   4. resolve_ref does not unconditionally downgrade to 'main' on an API error,
//   5. the install dir defaults to the canonical /opt/owlat (not $PWD/owlat),
//   6. the wizard image tag is pinned to OWLAT_VERSION rather than a mutable
//      unconditional ':latest', and an unpinnable ref warns loudly,
//   7. a commit-SHA OWLAT_REF is clone-then-checkout (or a clear error), not a
//      `git clone --branch <sha>` opaque failure.

const here = dirname(fileURLToPath(import.meta.url));
// apps/setup-cli/src/lib/__tests__ → repo root is five levels up.
const repoRoot = resolve(here, '../../../../..');
const installSh = readFileSync(resolve(repoRoot, 'install.sh'), 'utf8');
const owlatCli = readFileSync(resolve(repoRoot, 'scripts/owlat'), 'utf8');

/** Slice a bash function body (`name() { … \n}`) out of a script. */
function sliceFunction(src: string, name: string): string {
	const start = src.indexOf(`${name}()`);
	expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
	const end = src.indexOf('\n}', start);
	return src.slice(start, end < 0 ? undefined : end);
}

describe('installer entrypoints — registry/org defaults', () => {
	it('install.sh defaults OWLAT_REPO to wolvesdotink/owlat', () => {
		expect(installSh).toMatch(
			/OWLAT_REPO="\$\{OWLAT_REPO:-https:\/\/github\.com\/wolvesdotink\/owlat\.git\}"/,
		);
	});

	it('scripts/owlat defaults the setup image to ghcr.io/wolvesdotink', () => {
		expect(owlatCli).toContain('ghcr.io/wolvesdotink/setup:');
	});

	it('neither file still references the placeholder owlat/owlat org or ghcr.io/owlat', () => {
		for (const [name, src] of [
			['install.sh', installSh],
			['scripts/owlat', owlatCli],
		] as const) {
			expect(src, `${name} still references owlat/owlat`).not.toMatch(/owlat\/owlat/);
			expect(src, `${name} still references ghcr.io/owlat`).not.toMatch(/ghcr\.io\/owlat\b/);
		}
	});
});

describe('installer entrypoints — OWLAT_CONFIG_FILE bind-mount', () => {
	const inContainer = '/opt/owlat/.owlat-setup-config';

	it('scripts/owlat pins a fixed in-container config path', () => {
		expect(owlatCli).toContain(`CONFIG_IN_CONTAINER="${inContainer}"`);
	});

	it('scripts/owlat bind-mounts the host config file read-only at that path', () => {
		expect(owlatCli).toMatch(
			/-v\s+"\$OWLAT_CONFIG_FILE:\$CONFIG_IN_CONTAINER:ro"/,
		);
	});

	it('scripts/owlat rewrites --config to the in-container path', () => {
		expect(owlatCli).toMatch(/set --\s+"\$@"\s+--config\s+"\$CONFIG_IN_CONTAINER"/);
	});

	it('scripts/owlat passes the mount into the wizard docker run', () => {
		expect(owlatCli).toMatch(/\$\{CONFIG_MOUNT_ARGS\[@\]\+"\$\{CONFIG_MOUNT_ARGS\[@\]\}"\}/);
	});

	it('install.sh forwards OWLAT_CONFIG_FILE into the containerized wizard', () => {
		// The host path can't be passed verbatim to the container, so install.sh
		// exports it for scripts/owlat to mount instead of handing over `--config`.
		expect(installSh).toMatch(/OWLAT_CONFIG_FILE="\$OWLAT_CONFIG_FILE"\s*\\?\s*\n?\s*exec/);
	});
});

describe('installer entrypoints — docker daemon preflight', () => {
	it('install.sh checks the docker daemon is reachable, not just the CLI', () => {
		const fn = sliceFunction(installSh, 'preflight');
		expect(fn).toMatch(/if\s+!\s+docker\s+(info|version)\b/);
	});
});

describe('installer entrypoints — resolve_ref hardening', () => {
	const fn = sliceFunction(installSh, 'resolve_ref');

	it('inspects the HTTP status of the release API call', () => {
		expect(fn).toContain('%{http_code}');
	});

	it('treats only a 404 (no releases yet) as the default-branch fallback', () => {
		expect(fn).toMatch(/http_code"?\s*==\s*"?404/);
	});

	it('fails fast on a hard API error instead of silently downgrading to main', () => {
		// the bleeding-edge 'main' fallback must be guarded by the 404 branch, not
		// reached unconditionally via a bare `else`.
		expect(fn).not.toMatch(/\belse\b\s*\n\s*OWLAT_REF="main"/);
		expect(fn).toMatch(/\bdie\b/);
	});
});

describe('installer entrypoints — existing-clone update does not swallow errors', () => {
	const fn = sliceFunction(installSh, 'ensure_repo');

	it('does not silence git fetch/checkout failures with `|| true`', () => {
		// `|| true` on the update path means the requested ref may not be what
		// actually gets installed, yet the install proceeds anyway.
		const updateBlock = fn.slice(fn.indexOf('Existing clone'), fn.indexOf('else'));
		expect(updateBlock).not.toContain('|| true');
		expect(updateBlock).toContain('die ');
	});

	it('reachability-checks the repo before cloning', () => {
		expect(fn).toMatch(/git\s+ls-remote/);
	});
});

describe('installer entrypoints — install dir defaults to /opt/owlat', () => {
	it('install.sh defaults OWLAT_INSTALL_DIR to /opt/owlat (not $PWD/owlat)', () => {
		expect(installSh).toMatch(/OWLAT_INSTALL_DIR="\$\{OWLAT_INSTALL_DIR:-\/opt\/owlat\}"/);
		expect(installSh).not.toMatch(/OWLAT_INSTALL_DIR="\$\{OWLAT_INSTALL_DIR:-\$PWD\/owlat\}"/);
	});

	it('resolves the install dir before cloning (ensure_install_dir runs before ensure_repo)', () => {
		expect(installSh).toMatch(/ensure_install_dir\n\tensure_repo/);
	});

	it('creates the dir with sudo + chown when the parent is not writable', () => {
		const fn = sliceFunction(installSh, 'ensure_install_dir');
		// /opt is typically root-owned; rather than dying with a late clone
		// permission error, create it with sudo and hand ownership to the invoker.
		expect(fn).toMatch(/sudo mkdir -p "\$OWLAT_INSTALL_DIR"/);
		expect(fn).toMatch(/sudo chown/);
		// Still honours an explicit override / fails with an actionable hint
		// (the `$` is backslash-escaped inside the double-quoted die string).
		expect(fn).toMatch(/OWLAT_INSTALL_DIR=\\?\$PWD\/owlat/);
	});
});

describe('installer entrypoints — setup-image tag pinning', () => {
	it('scripts/owlat reads the pinned OWLAT_VERSION from .env, not an unconditional :latest', () => {
		expect(owlatCli).toMatch(/grep -E '\^OWLAT_VERSION=' "\$OWLAT_DIR\/\.env"/);
		// the old unconditional `${OWLAT_VERSION:-latest}` derivation is gone…
		expect(owlatCli).not.toMatch(/OWLAT_VERSION_TAG="\$\{OWLAT_VERSION:-latest\}"/);
		// …though 'latest' survives only as the final last-resort fallback.
		expect(owlatCli).toMatch(/OWLAT_VERSION_TAG="\$\{OWLAT_VERSION_TAG:-latest\}"/);
	});

	it('install.sh derives the wizard tag from a vX.Y.Z ref and warns when it cannot pin', () => {
		const fn = sliceFunction(installSh, 'run_wizard');
		expect(fn).toContain('setup_tag="$ref_ver"');
		expect(fn).toMatch(/Could not pin the setup wizard image/);
	});
});

describe('installer entrypoints — commit-SHA OWLAT_REF handling', () => {
	const fn = sliceFunction(installSh, 'ensure_repo');

	it('detects a 40-hex commit SHA', () => {
		expect(fn).toMatch(/\[0-9a-fA-F\]\{40\}/);
	});

	it('clone-then-checkouts the SHA (git clone --branch rejects a SHA)', () => {
		// A full clone followed by a detached checkout, since `--branch <sha>`
		// hard-fails with an opaque "Remote branch <sha> not found".
		expect(fn).toMatch(/checkout --detach "\$OWLAT_REF"/);
	});

	it('fails with a clear message when the commit is not on the remote', () => {
		expect(fn).toMatch(/must be a tag, a branch, or a commit/);
	});
});
