#!/usr/bin/env bun
/**
 * Desktop auth spike — the "open" end-to-end verification from the plan
 * (Sequencing step 1, risks R1 + R3).
 *
 * It exercises the SAME cookieless cross-domain chain the packaged desktop app
 * uses (apps/web auth-client.ts / convex-auth.ts / useDesktopWorkspaces.ts),
 * but headless from Node/Bun — so you can confirm the whole flow against a real
 * instance without building the GUI:
 *
 *   R3a  sign in through the cross-domain client (session stored in-memory,
 *        no cookies) — emulates a connected workspace
 *   R1   GET /api/auth/convex/token with the Better-Auth-Cookie header → a JWT
 *   R3b  GET /api/auth/one-time-token/generate → a one-time token
 *        (what /desktop/connect hands back via owlat://auth)
 *   R3c  a FRESH client redeems it via POST /api/auth/cross-domain/one-time-token/verify
 *        (what the deep-link handler does) …
 *   R1'  … then mints a convex JWT too — proving the redeemed session works
 *
 * Prereqs: an instance reachable at CONVEX_SITE_URL (where /api/auth/* lives,
 * i.e. the *.convex.site URL) running this branch's apps/api (crossDomain +
 * oneTimeToken plugins), and a known email/password user.
 *
 * Usage:
 *   CONVEX_SITE_URL=https://<deployment>.convex.site \
 *   TEST_EMAIL=you@example.com TEST_PASSWORD='…' \
 *     bun apps/desktop/scripts/auth-spike.mjs
 *
 * Exit code is non-zero if any check fails.
 */
import { createAuthClient } from 'better-auth/client';
import { convexClient, crossDomainClient } from '@convex-dev/better-auth/client/plugins';

const CONVEX_SITE_URL = (process.env.CONVEX_SITE_URL || '').replace(/\/+$/, '');
const TEST_EMAIL = process.env.TEST_EMAIL || '';
const TEST_PASSWORD = process.env.TEST_PASSWORD || '';

if (!CONVEX_SITE_URL || !TEST_EMAIL || !TEST_PASSWORD) {
	console.error(
		'Missing config. Set CONVEX_SITE_URL, TEST_EMAIL, TEST_PASSWORD.\n' +
			'  CONVEX_SITE_URL=https://<deployment>.convex.site \\\n' +
			"  TEST_EMAIL=you@example.com TEST_PASSWORD='…' \\\n" +
			'    bun apps/desktop/scripts/auth-spike.mjs',
	);
	process.exit(2);
}

/** Synchronous in-memory storage standing in for the OS keychain. */
function memStorage() {
	const m = new Map();
	return {
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => {
			m.set(k, v);
		},
	};
}

/** A client wired exactly like the desktop's auth-client.ts (minus the org plugin). */
function makeClient() {
	return createAuthClient({
		baseURL: CONVEX_SITE_URL,
		plugins: [convexClient(), crossDomainClient({ storage: memStorage() })],
	});
}

/** better-fetch returns `{ data, error }`; unwrap a `{ token }` payload either way. */
function tokenOf(res) {
	return res?.data?.token ?? res?.token ?? null;
}

function decodeJwt(jwt) {
	try {
		const part = jwt.split('.')[1] ?? '';
		return JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
	} catch {
		return null;
	}
}

let failures = 0;
function check(name, ok, detail) {
	if (ok) {
		console.log(`✓ ${name}`);
	} else {
		failures++;
		console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

async function getConvexToken(client) {
	// Mirrors convex-auth.ts: GET /api/auth/convex/token, session carried by the
	// cross-domain client's Better-Auth-Cookie header (no cookies).
	const res = await client.$fetch('/convex/token', { method: 'GET' });
	return { token: tokenOf(res), error: res?.error };
}

async function main() {
	console.log(`→ instance: ${CONVEX_SITE_URL}\n`);

	// R3a — sign in through the cross-domain client.
	const c1 = makeClient();
	const signIn = await c1.signIn.email({ email: TEST_EMAIL, password: TEST_PASSWORD });
	check('R3a  cross-domain sign-in', !signIn?.error, JSON.stringify(signIn?.error));

	// R1 — cookieless convex JWT.
	const t1 = await getConvexToken(c1);
	check('R1   convex JWT minted (cookieless)', !!t1.token, JSON.stringify(t1.error));
	if (t1.token) {
		const claims = decodeJwt(t1.token);
		check('R1   JWT decodes with exp', !!claims?.exp, JSON.stringify(claims));
		console.log(`     claims: ${claims ? Object.keys(claims).join(', ') : '—'}`);
	}

	// R3b — generate a one-time token (what /desktop/connect returns).
	const gen = await c1.$fetch('/one-time-token/generate', { method: 'GET' });
	const ott = tokenOf(gen);
	check('R3b  one-time-token generated', !!ott, JSON.stringify(gen?.error));

	// R3c + R1' — a fresh client (no prior session) redeems the token and then
	// mints its own convex JWT. This is exactly the deep-link redemption path.
	if (ott) {
		const c2 = makeClient();
		const verify = await c2.$fetch('/cross-domain/one-time-token/verify', {
			method: 'POST',
			body: { token: ott },
		});
		check('R3c  fresh client redeems one-time token', !verify?.error, JSON.stringify(verify?.error));

		const t2 = await getConvexToken(c2);
		check("R1'  redeemed session mints convex JWT", !!t2.token, JSON.stringify(t2.error));
	}

	console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error('Spike crashed:', e);
	process.exit(1);
});
