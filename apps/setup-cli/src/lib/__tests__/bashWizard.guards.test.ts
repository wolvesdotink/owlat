import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// The legacy bash wizard (scripts/setup.sh) is still reachable as install.sh's
// fallback and is referenced by the README, but it is not exercised by any
// runtime test. These guard assertions lock the "bash-wizard-abort" fix so the
// wizard cannot regress back to: a dead nest-api-deploy abort, an unset
// INSTANCE_SECRET (→ /seed/admin 401), or an unguarded spinner that aborts the
// whole run under `set -euo pipefail`.

const here = dirname(fileURLToPath(import.meta.url));
// apps/setup-cli/src/lib/__tests__ → repo root is five levels up.
const setupSh = resolve(here, '../../../../../scripts/setup.sh');
const script = readFileSync(setupSh, 'utf8');
const lines = script.split('\n');

describe('scripts/setup.sh — bash-wizard-abort guards', () => {
	it('has no reference to the removed nest-api-deploy service', () => {
		// Nest was extracted to its own repo; the service no longer exists and
		// running it under `set -e` killed the wizard before admin seeding.
		expect(script).not.toContain('nest-api-deploy');
	});

	it('pushes INSTANCE_SECRET into the Convex deployment', () => {
		// seedAdmin.ts compares X-Instance-Secret against INSTANCE_SECRET, so the
		// wizard must set it in Convex (not just the self-host .env) or
		// /seed/admin returns 401.
		expect(script).toMatch(/set_convex_var\s+"INSTANCE_SECRET"\s+"\$SELFHOST_INSTANCE_SECRET"/);
	});

	it('checks for npx as a self-host prerequisite', () => {
		// The self-host path shells out to host `npx convex`; fail fast if absent.
		expect(script).toMatch(/command -v npx/);
	});

	it('guards every spinner invocation so a failed step degrades under set -e', () => {
		// A bare `spinner "$pid" "…"` on its own line returns the step's non-zero
		// exit code, which aborts the script under `set -e` before the following
		// soft-warn/retry can run. Each invocation (excluding the definition) must
		// be guarded with `if [ ! ] spinner` or `|| true`.
		const invocations = lines.filter(
			(line) => /\bspinner\s+"/.test(line) && !line.includes('spinner()'),
		);
		expect(invocations.length).toBeGreaterThan(0);
		for (const line of invocations) {
			const trimmed = line.trim();
			const guarded = /^if\s+(!\s+)?spinner\b/.test(trimmed) || /\|\|\s*true\b/.test(trimmed);
			expect(guarded, `unguarded spinner call: ${trimmed}`).toBe(true);
		}
	});

	it('guards the Convex-deploy spinner specifically', () => {
		const deployLine = lines.find(
			(line) => /\bspinner\b/.test(line) && line.includes('"Deploying Convex functions..."'),
		);
		expect(deployLine, 'Convex-deploy spinner line not found').toBeDefined();
		const trimmed = (deployLine ?? '').trim();
		const guarded = /^if\s+(!\s+)?spinner\b/.test(trimmed) || /\|\|\s*true\b/.test(trimmed);
		expect(guarded, `unguarded Convex-deploy spinner: ${trimmed}`).toBe(true);
	});

	it('never pushes CONVEX_SITE_URL as a Convex var (it is a forbidden built-in)', () => {
		// CONVEX_SITE_URL is derived by the backend from CONVEX_SITE_ORIGIN;
		// `convex env set CONVEX_SITE_URL` is rejected with EnvVarNameForbidden, so
		// passing it to set_convex_var only yields a spurious "failed to set". It
		// must stay in the compose .env / NUXT_PUBLIC_CONVEX_SITE_URL only.
		expect(script).not.toMatch(/set_convex_var\s+"CONVEX_SITE_URL"/);
	});
});
