/**
 * `bun run dev:seed` — opt-in dummy accounts + demo data for the LOCAL dev stack.
 *
 * Seeding never happens automatically; a developer who wants a populated
 * instance runs this once after `bun run dev` (or `bun run dev:api`) is up.
 * A developer who wants a blank instance simply never runs it.
 *
 * What it does, in order:
 *   1. Refuses to target anything but a localhost Convex site URL.
 *   2. Ensures `INSTANCE_SECRET` and `OWLAT_DEV_MODE=true` are set on the
 *      local deployment (via `bunx convex env` in apps/api), generating a
 *      random secret on first run.
 *   3. `POST /seed/admin` — owner account dev@example.com / devpassword12345
 *      (one-shot; a 409 means an owner already exists and is left untouched).
 *   4. `POST /seed/demo` — demo content (topics, contacts, campaigns, …) plus
 *      the dummy teammate accounts from
 *      apps/api/convex/seedDemo/fixtures/accounts.json. Idempotent.
 *
 * Flags:
 *   --reset   wipe seed-tagged demo rows first, then reseed (accounts persist)
 *   --wipe    full `POST /dev/reset` (blank instance, ALL data + accounts
 *             deleted) before seeding from scratch
 *
 * The credentials printed at the end mirror the accounts fixture — keep the
 * two in sync when editing either.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashPassword } from '@owlat/shared/passwordHash';

const ROOT = join(import.meta.dir, '..');
const API_DIR = join(ROOT, 'apps', 'api');

const ADMIN = { email: 'dev@example.com', name: 'Dev Admin', password: 'devpassword12345' };
// Mirrors apps/api/convex/seedDemo/fixtures/accounts.json.
const TEAMMATES = [
	{ email: 'taylor@example.com', password: 'devpassword12345', role: 'admin' },
	{ email: 'jordan@example.com', password: 'devpassword12345', role: 'member' },
];

function fail(message: string): never {
	console.error(`\n✗ ${message}`);
	process.exit(1);
}

function parseEnvFile(path: string): Record<string, string> {
	if (!existsSync(path)) return {};
	const out: Record<string, string> = {};
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
		if (match) out[match[1]!] = match[2]!.replace(/^['"]|['"]$/g, '');
	}
	return out;
}

function convexCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync('bunx', ['convex', ...args], { cwd: API_DIR, encoding: 'utf8' });
	return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function getDeploymentEnv(name: string): string | null {
	const result = convexCli(['env', 'get', name]);
	const value = result.stdout.trim();
	return result.status === 0 && value.length > 0 ? value : null;
}

function setDeploymentEnv(name: string, value: string): void {
	const result = convexCli(['env', 'set', name, value]);
	if (result.status !== 0) {
		fail(`Could not set ${name} on the local deployment:\n${result.stderr.trim()}`);
	}
	console.log(`  set ${name} on the local deployment`);
}

async function post(
	siteUrl: string,
	secret: string,
	path: string,
	body?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(`${siteUrl}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Instance-Secret': secret },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	let parsed: Record<string, unknown> = {};
	try {
		parsed = (await response.json()) as Record<string, unknown>;
	} catch {
		// non-JSON error body; status alone is enough to report
	}
	return { status: response.status, body: parsed };
}

function summarize(label: string, counts: unknown): void {
	if (!counts || typeof counts !== 'object') return;
	const entries = Object.entries(counts as Record<string, number>).filter(([, n]) => n > 0);
	if (entries.length === 0) return;
	console.log(`  ${label}: ${entries.map(([k, n]) => `${k} ${n}`).join(', ')}`);
}

async function main(): Promise<void> {
	const args = new Set(process.argv.slice(2));
	if (args.has('--help') || args.has('-h')) {
		console.log('Usage: bun run dev:seed [--reset] [--wipe]');
		console.log('  --reset  wipe seed-tagged demo rows, then reseed (accounts persist)');
		console.log('  --wipe   POST /dev/reset first: blank instance, then seed from scratch');
		return;
	}

	const apiEnv = parseEnvFile(join(API_DIR, '.env.local'));
	const siteUrl = (
		process.env.CONVEX_SITE_URL ??
		apiEnv.CONVEX_SITE_URL ??
		'http://127.0.0.1:3211'
	).replace(/\/$/, '');

	const host = new URL(siteUrl).hostname;
	if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
		fail(`This script only seeds the LOCAL dev stack, but CONVEX_SITE_URL points at ${host}.`);
	}

	console.log(`Seeding local dev stack at ${siteUrl}\n`);

	try {
		await fetch(siteUrl);
	} catch {
		fail(`Local Convex backend is not reachable at ${siteUrl}.\n  Start it first: bun run dev:api`);
	}

	// 1. Deployment env: instance secret + dev-mode opt-in for /seed and /dev routes.
	let secret = getDeploymentEnv('INSTANCE_SECRET');
	if (!secret) {
		secret = randomBytes(32).toString('hex');
		setDeploymentEnv('INSTANCE_SECRET', secret);
	}
	if (getDeploymentEnv('OWLAT_DEV_MODE') !== 'true') {
		setDeploymentEnv('OWLAT_DEV_MODE', 'true');
	}

	// 2. Optional full wipe back to a blank instance.
	if (args.has('--wipe')) {
		const wiped = await post(siteUrl, secret, '/dev/reset');
		if (wiped.status !== 200) {
			fail(`/dev/reset failed (${wiped.status}): ${JSON.stringify(wiped.body)}`);
		}
		summarize('wiped', wiped.body.deleted);
	}

	// 3. Owner account (one-shot; 409 = someone already bootstrapped this instance).
	const adminResult = await post(siteUrl, secret, '/seed/admin', {
		email: ADMIN.email,
		name: ADMIN.name,
		passwordHash: await hashPassword(ADMIN.password),
	});
	let adminCreated = false;
	if (adminResult.status === 201) {
		adminCreated = true;
		console.log(`  created owner account ${ADMIN.email}`);
	} else if (adminResult.status === 409) {
		console.log('  owner account already exists — left untouched');
	} else {
		fail(`/seed/admin failed (${adminResult.status}): ${JSON.stringify(adminResult.body)}`);
	}

	// 4. Demo content + teammate accounts.
	const query = args.has('--reset') ? '?reset=true' : '';
	const demoResult = await post(siteUrl, secret, `/seed/demo${query}`);
	if (demoResult.status !== 200) {
		fail(`/seed/demo failed (${demoResult.status}): ${JSON.stringify(demoResult.body)}`);
	}
	summarize('deleted', demoResult.body.deleted);
	summarize('inserted', demoResult.body.inserted);
	summarize('skipped (already present)', demoResult.body.skipped);

	const appUrl = getDeploymentEnv('SITE_URL') ?? 'http://localhost:3000';
	console.log(`\n✓ Done. Sign in at ${appUrl}`);
	if (adminCreated) {
		console.log(`    ${ADMIN.email.padEnd(24)}${ADMIN.password}   (owner)`);
	} else {
		console.log('    owner: pre-existing account, original credentials unchanged');
	}
	for (const t of TEAMMATES) {
		console.log(`    ${t.email.padEnd(24)}${t.password}   (${t.role})`);
	}
}

await main();
