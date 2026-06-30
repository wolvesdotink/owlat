/**
 * Integration tests for the public, token-gated HTTP links, driven through
 * `t.fetch(...)` so they exercise the real routing in `http.ts`:
 *
 *   - GET  /t/c/{emailSendId}/{encodedUrl}/{signature}  (delivery/trackingHttp.trackClick)
 *   - GET  /t/o/{emailSendId}                            (delivery/trackingHttp.trackOpen)
 *   - POST /unsub/{token}                                (delivery/unsubscribeHttp.handleOneClickUnsubscribe)
 *   - GET  /prefs/verify/{token} + POST /prefs/update/{token} (delivery/preferencesHttp)
 *   - POST /seed/admin                                   (seedAdmin)
 *
 * The click/unsub/prefs tokens are HMAC-SHA256 over their canonical payload,
 * base64url-encoded with UNSUBSCRIBE_SECRET. We recompute those signatures
 * byte-for-byte here (mirroring delivery/sendComposition/transform.ts and
 * delivery/{unsubscribe,preferences}.ts) so a "valid" link is genuinely valid
 * and a tampered one is genuinely forged.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { createTestContact, createTestTopic } from './factories';

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([p]) =>
			!p.includes('sesActions') &&
			!p.includes('agentSecurity') &&
			!p.includes('agentContext') &&
			!p.includes('agentClassifier') &&
			!p.includes('agentDrafter') &&
			!p.includes('agentRouter') &&
			!p.includes('agent/walker') &&
			!p.includes('agent/steps/index') &&
			!p.includes('agent/steps/shared') &&
			!p.includes('agent/steps/classify') &&
			!p.includes('agent/steps/draft') &&
			!p.includes('knowledgeExtraction') &&
			!p.includes('semanticFileProcessing') &&
			!p.includes('visualizationAgent') &&
			!p.includes('llmProvider'),
	),
);

function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

const SECRET = 'test-unsubscribe-secret';
const SAVED_ENV = { ...process.env };

beforeEach(() => {
	process.env['UNSUBSCRIBE_SECRET'] = SECRET;
	process.env['INSTANCE_SECRET'] = 'test-instance-secret';
});

afterEach(() => {
	process.env = { ...SAVED_ENV };
});

// ─── Crypto helpers (mirror the encode side byte-for-byte) ──────────────────

// base64url WITHOUT padding — matches Node's `.digest('base64url')` and
// `Buffer.from(...).toString('base64url')`.
function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function utf8ToBase64Url(str: string): string {
	const bytes = new TextEncoder().encode(str);
	return bytesToBase64Url(bytes);
}

async function hmacBase64Url(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	return bytesToBase64Url(new Uint8Array(mac));
}

// Unsubscribe token: `{contactId}:{timestamp}:{HMAC(secret, "{contactId}:{timestamp}")}`
async function makeUnsubToken(contactId: string, timestamp = Date.now()): Promise<string> {
	const ts = String(timestamp);
	const sig = await hmacBase64Url(SECRET, `${contactId}:${ts}`);
	return `${contactId}:${ts}:${sig}`;
}

// Preference token: same shape, payload prefixed with `pref:`.
async function makePrefToken(contactId: string, timestamp = Date.now()): Promise<string> {
	const ts = String(timestamp);
	const sig = await hmacBase64Url(SECRET, `pref:${contactId}:${ts}`);
	return `${contactId}:${ts}:${sig}`;
}

// Click link: `/t/c/{emailSendId}/{base64url(href)}/{HMAC(secret, "{emailSendId}.{encodedUrl}")}`
async function makeClickPath(emailSendId: string, href: string): Promise<string> {
	const encodedUrl = utf8ToBase64Url(href);
	const sig = await hmacBase64Url(SECRET, `${emailSendId}.${encodedUrl}`);
	return `/t/c/${emailSendId}/${encodedUrl}/${sig}`;
}

// ─── DB seeding ─────────────────────────────────────────────────────────────

async function seedContact(
	t: ReturnType<typeof convexTest>,
	overrides: Record<string, unknown> = {},
): Promise<Id<'contacts'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('contacts', createTestContact(overrides) as never),
	);
}

async function seedEmailSend(
	t: ReturnType<typeof convexTest>,
	overrides: Record<string, unknown> = {},
): Promise<Id<'emailSends'>> {
	const now = Date.now();
	return await t.run(async (ctx) => {
		const campaignId = await ctx.db.insert('campaigns', {
			name: 'Test Campaign',
			status: 'sending',
			fromName: 'Test',
			fromEmail: 'sender@example.com',
			subject: 'Subject',
			statsSent: 0,
			statsDelivered: 0,
			statsOpened: 0,
			statsClicked: 0,
			statsBounced: 0,
			statsUnsubscribed: 0,
			isABTest: false,
			searchableText: 'test campaign',
			createdAt: now,
			updatedAt: now,
		} as never);
		const contactId = await ctx.db.insert('contacts', createTestContact() as never);
		return ctx.db.insert('emailSends', {
			campaignId,
			contactId,
			contactEmail: 'recipient@example.com',
			status: 'delivered',
			queuedAt: now,
			openCount: 0,
			...overrides,
		} as never);
	});
}

// ============================================================================
// Click tracking — GET /t/c/{emailSendId}/{encodedUrl}/{signature}
// ============================================================================

describe('trackClick (GET /t/c/...)', () => {
	const TARGET = 'https://example.com/landing?x=1';

	it('302-redirects to the decoded URL for a valid signature', async () => {
		const t = setupTest();
		const emailSendId = await seedEmailSend(t);
		const path = await makeClickPath(emailSendId, TARGET);

		const res = await t.fetch(path, { method: 'GET', redirect: 'manual' });
		expect(res.status).toBe(302);
		// Location is the round-tripped target (new URL(...).toString()).
		expect(res.headers.get('Location')).toBe(new URL(TARGET).toString());
	});

	it('does NOT redirect to the attacker URL when the signature is tampered', async () => {
		const t = setupTest();
		const emailSendId = await seedEmailSend(t);
		const encodedUrl = utf8ToBase64Url('https://attacker.example/phish');
		// A signature that is well-formed but not the real HMAC for this payload.
		const forgedSig = bytesToBase64Url(new Uint8Array(32));
		const path = `/t/c/${emailSendId}/${encodedUrl}/${forgedSig}`;

		const res = await t.fetch(path, { method: 'GET', redirect: 'manual' });
		expect(res.status).toBe(302);
		// Open-redirect guard: falls back to '/', never the attacker host.
		const location = res.headers.get('Location');
		expect(location).toBe('/');
		expect(location).not.toContain('attacker.example');
	});

	it('does NOT honor a valid signature replayed onto a different (swapped) URL', async () => {
		const t = setupTest();
		const emailSendId = await seedEmailSend(t);
		// Sign the benign URL...
		const { sig } = await (async () => {
			const encoded = utf8ToBase64Url(TARGET);
			return { sig: await hmacBase64Url(SECRET, `${emailSendId}.${encoded}`) };
		})();
		// ...then graft that signature onto the attacker-controlled encoded URL.
		const swappedEncoded = utf8ToBase64Url('https://attacker.example/phish');
		const path = `/t/c/${emailSendId}/${swappedEncoded}/${sig}`;

		const res = await t.fetch(path, { method: 'GET', redirect: 'manual' });
		expect(res.status).toBe(302);
		const location = res.headers.get('Location');
		expect(location).toBe('/');
		expect(location).not.toContain('attacker.example');
	});

	it('falls back to "/" when the emailSendId is not a valid Convex id', async () => {
		const t = setupTest();
		// Sign a payload whose id is too short to pass isValidConvexId.
		const badId = 'short';
		const path = await makeClickPath(badId, TARGET);

		const res = await t.fetch(path, { method: 'GET', redirect: 'manual' });
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/');
	});

	it('falls back to "/" for a valid signature whose emailSend row does not exist', async () => {
		const t = setupTest();
		// A genuine (and thus validator-acceptable) emailSends id that has since
		// been deleted — getEmailSendForTracking returns null, so the redirect
		// target is dropped even though the signature is correct.
		const ghostId = await seedEmailSend(t);
		await t.run(async (ctx) => ctx.db.delete(ghostId));
		const path = await makeClickPath(ghostId, TARGET);

		const res = await t.fetch(path, { method: 'GET', redirect: 'manual' });
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/');
	});
});

// ============================================================================
// Open tracking — GET /t/o/{emailSendId}
// ============================================================================

describe('trackOpen (GET /t/o/...)', () => {
	it('returns a 200 GIF pixel for a real emailSendId', async () => {
		const t = setupTest();
		const emailSendId = await seedEmailSend(t);

		const res = await t.fetch(`/t/o/${emailSendId}`, { method: 'GET' });
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/gif');
		const body = new Uint8Array(await res.arrayBuffer());
		// GIF magic: "GIF89a"
		expect(Array.from(body.slice(0, 6))).toEqual([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
	});

	it('still returns a 200 pixel (benign) for a bogus emailSendId', async () => {
		const t = setupTest();
		const res = await t.fetch('/t/o/not-a-valid-id', { method: 'GET' });
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/gif');
	});
});

// ============================================================================
// One-click unsubscribe — POST /unsub/{token}
// ============================================================================

describe('handleOneClickUnsubscribe (POST /unsub/...)', () => {
	it('unsubscribes a contact with a valid token (200, ok:true)', async () => {
		const t = setupTest();
		const contactId = await seedContact(t);
		const token = await makeUnsubToken(contactId);

		const res = await t.fetch(`/unsub/${encodeURIComponent(token)}`, { method: 'POST' });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean; data: { listsRemoved: number } };
		expect(json.ok).toBe(true);
		// No topic memberships seeded → "already unsubscribed", 0 removed.
		expect(json.data.listsRemoved).toBe(0);
	});

	it('rejects a bogus token (400) without unsubscribing', async () => {
		const t = setupTest();
		const res = await t.fetch(`/unsub/${encodeURIComponent('not-a-real-token')}`, {
			method: 'POST',
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error: { message: string } };
		expect(json.error).toBeDefined();
	});

	it('rejects a token whose signature does not match its contactId (IDOR-safe)', async () => {
		const t = setupTest();
		const contactId = await seedContact(t);
		// Build a valid token for contactId, then swap the id segment for the
		// victim's — the signature no longer matches, so it must be rejected
		// (an attacker cannot retarget a held token at another contact).
		const victimId = await seedContact(t);
		const ts = String(Date.now());
		const sigForAttacker = await hmacBase64Url(SECRET, `${contactId}:${ts}`);
		const forgedToken = `${victimId}:${ts}:${sigForAttacker}`;

		const res = await t.fetch(`/unsub/${encodeURIComponent(forgedToken)}`, { method: 'POST' });
		expect(res.status).toBe(400);
	});

	it('rejects an expired token (400)', async () => {
		const t = setupTest();
		const contactId = await seedContact(t);
		// 91 days old — past the 90-day TTL. Signature is correct for the payload.
		const oldTs = Date.now() - 91 * 24 * 60 * 60 * 1000;
		const token = await makeUnsubToken(contactId, oldTs);

		const res = await t.fetch(`/unsub/${encodeURIComponent(token)}`, { method: 'POST' });
		expect(res.status).toBe(400);
	});
});

// ============================================================================
// RFC 8058 one-click unsubscribe — regression lock (audit PR-20)
//
// The POST /unsub/{token} endpoint is the RFC 8058 §3.1/§3.2 one-click target:
// an unauthenticated, body-tolerant, server-to-server POST that honors the
// unsubscribe IMMEDIATELY (no login, no landing page, no confirmation step).
// These cases lock the end-to-end contract that the shape-level tests above
// only partially cover:
//   1. a valid token removes the actual contactTopics rows, with NO auth headers;
//   2. a tampered / expired token is a no-op — memberships are untouched;
//   3. re-POSTing an already-unsubscribed token reports "alreadyUnsubscribed";
//   4. the body is tolerated in every RFC 8058 form (the canonical
//      `List-Unsubscribe=One-Click` form post AND an empty body) — never a body
//      error; and
//   5. the campaign audience resolution excludes the contact once unsubscribed.
// ============================================================================

/** Seed a topic and subscribe `contactId` to it. Returns the topic id. */
async function seedTopicMembership(
	t: ReturnType<typeof convexTest>,
	contactId: Id<'contacts'>,
	topicOverrides: Record<string, unknown> = {},
): Promise<Id<'topics'>> {
	const now = Date.now();
	return await t.run(async (ctx) => {
		const topicId = await ctx.db.insert(
			'topics',
			createTestTopic(topicOverrides) as never,
		);
		await ctx.db.insert('contactTopics', {
			contactId,
			topicId,
			addedAt: now,
		} as never);
		return topicId;
	});
}

/** Count the contact's current topic memberships. */
async function countMemberships(
	t: ReturnType<typeof setupTest>,
	contactId: Id<'contacts'>,
): Promise<number> {
	const rows = await t.run(async (ctx) =>
		ctx.db
			.query('contactTopics')
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.collect(),
	);
	return rows.length;
}

describe('handleOneClickUnsubscribe — RFC 8058 regression lock (PR-20)', () => {
	it('valid token removes the contactTopics rows and returns 200 {ok:true} with NO auth headers', async () => {
		const t = setupTest();
		const contactId = await seedContact(t);
		await seedTopicMembership(t, contactId, { name: 'Alpha' });
		await seedTopicMembership(t, contactId, { name: 'Beta' });
		expect(await countMemberships(t, contactId)).toBe(2);

		const token = await makeUnsubToken(contactId);
		// Deliberately send NO Authorization and NO Cookie header — RFC 8058 §3.2
		// requires the one-click POST to be honored without any session.
		const res = await t.fetch(`/unsub/${encodeURIComponent(token)}`, {
			method: 'POST',
		});

		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			ok: boolean;
			data: { listsRemoved: number };
		};
		expect(json.ok).toBe(true);
		expect(json.data.listsRemoved).toBe(2);

		// The honor is immediate: every membership row is gone now (no landing
		// page, no deferred confirmation).
		expect(await countMemberships(t, contactId)).toBe(0);
	});

	it('still succeeds when Authorization and Cookie headers are present (auth is irrelevant, never blocks)', async () => {
		const t = setupTest();
		const contactId = await seedContact(t);
		await seedTopicMembership(t, contactId, { name: 'Gamma' });

		const token = await makeUnsubToken(contactId);
		const res = await t.fetch(`/unsub/${encodeURIComponent(token)}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer totally-irrelevant',
				Cookie: 'session=irrelevant',
			},
		});

		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean; data: { listsRemoved: number } };
		expect(json.ok).toBe(true);
		expect(json.data.listsRemoved).toBe(1);
		expect(await countMemberships(t, contactId)).toBe(0);
	});

	it('re-POSTing the same valid token reports alreadyUnsubscribed (listsRemoved:0) and is idempotent', async () => {
		const t = setupTest();
		const contactId = await seedContact(t);
		await seedTopicMembership(t, contactId, { name: 'Delta' });

		const token = await makeUnsubToken(contactId);

		const first = await t.fetch(`/unsub/${encodeURIComponent(token)}`, { method: 'POST' });
		expect(first.status).toBe(200);
		expect(((await first.json()) as { data: { listsRemoved: number } }).data.listsRemoved).toBe(1);
		expect(await countMemberships(t, contactId)).toBe(0);

		// Second POST with the SAME token — already removed → alreadyUnsubscribed,
		// nothing further removed. Still a clean 200 {ok:true}.
		const second = await t.fetch(`/unsub/${encodeURIComponent(token)}`, { method: 'POST' });
		expect(second.status).toBe(200);
		const json = (await second.json()) as { ok: boolean; data: { listsRemoved: number } };
		expect(json.ok).toBe(true);
		expect(json.data.listsRemoved).toBe(0);
		expect(await countMemberships(t, contactId)).toBe(0);
	});

	it('tampered signature is a 400 no-op — memberships are unchanged', async () => {
		const t = setupTest();
		const contactId = await seedContact(t);
		await seedTopicMembership(t, contactId, { name: 'Epsilon' });
		expect(await countMemberships(t, contactId)).toBe(1);

		// Correct id + timestamp, but a forged (all-zero) signature.
		const ts = String(Date.now());
		const forgedSig = bytesToBase64Url(new Uint8Array(32));
		const tamperedToken = `${contactId}:${ts}:${forgedSig}`;

		const res = await t.fetch(`/unsub/${encodeURIComponent(tamperedToken)}`, { method: 'POST' });
		expect(res.status).toBe(400);

		// No change: the membership survives a forged unsubscribe.
		expect(await countMemberships(t, contactId)).toBe(1);
	});

	it('expired token is a 400 no-op — memberships are unchanged', async () => {
		const t = setupTest();
		const contactId = await seedContact(t);
		await seedTopicMembership(t, contactId, { name: 'Zeta' });
		expect(await countMemberships(t, contactId)).toBe(1);

		// 91 days old — past the 90-day TTL, signature correct for the payload.
		const oldTs = Date.now() - 91 * 24 * 60 * 60 * 1000;
		const token = await makeUnsubToken(contactId, oldTs);

		const res = await t.fetch(`/unsub/${encodeURIComponent(token)}`, { method: 'POST' });
		expect(res.status).toBe(400);

		expect(await countMemberships(t, contactId)).toBe(1);
	});

	it('tolerates the canonical "List-Unsubscribe=One-Click" form body (200, never a body error)', async () => {
		const t = setupTest();
		const contactId = await seedContact(t);
		await seedTopicMembership(t, contactId, { name: 'Eta' });

		const token = await makeUnsubToken(contactId);
		// RFC 8058 §3.1: the mail client POSTs `List-Unsubscribe=One-Click` as a
		// urlencoded form body. It must be tolerated, not rejected as a bad body.
		const res = await t.fetch(`/unsub/${encodeURIComponent(token)}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'List-Unsubscribe=One-Click',
		});

		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean; data: { listsRemoved: number } };
		expect(json.ok).toBe(true);
		expect(json.data.listsRemoved).toBe(1);
		expect(await countMemberships(t, contactId)).toBe(0);
	});

	it('tolerates an empty body (200, never a body error)', async () => {
		const t = setupTest();
		const contactId = await seedContact(t);
		await seedTopicMembership(t, contactId, { name: 'Theta' });

		const token = await makeUnsubToken(contactId);
		// Some clients POST with no body at all — also valid one-click.
		const res = await t.fetch(`/unsub/${encodeURIComponent(token)}`, {
			method: 'POST',
			body: '',
		});

		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean };
		expect(json.ok).toBe(true);
		expect(await countMemberships(t, contactId)).toBe(0);
	});

	it('campaign audience excludes the contact after a one-click unsubscribe', async () => {
		const t = setupTest();
		const contactId = await seedContact(t, { email: 'audience-test@example.com' });
		const topicId = await seedTopicMembership(t, contactId, {
			name: 'Audience Topic',
			// not_required DOI on the seeded contact + non-DOI topic → eligible.
			requireDoubleOptIn: false,
		});

		// Before: the topic audience resolves to exactly this contact.
		const before = await t.run(async (ctx) =>
			ctx.runQuery(internal.campaigns.audienceResolution.resolveRecipients, {
				audience: { kind: 'topic' as const, topicId },
			}),
		);
		expect(before.map((r: { email: string }) => r.email)).toContain(
			'audience-test@example.com',
		);

		// One-click unsubscribe.
		const token = await makeUnsubToken(contactId);
		const res = await t.fetch(`/unsub/${encodeURIComponent(token)}`, { method: 'POST' });
		expect(res.status).toBe(200);

		// After: the membership is gone, so the audience no longer includes them.
		const after = await t.run(async (ctx) =>
			ctx.runQuery(internal.campaigns.audienceResolution.resolveRecipients, {
				audience: { kind: 'topic' as const, topicId },
			}),
		);
		expect(after).toHaveLength(0);
	});
});

// ============================================================================
// Preference center — GET /prefs/verify/{token} + POST /prefs/update/{token}
// ============================================================================

describe('verifyPreferenceToken (GET /prefs/verify/...)', () => {
	it('returns the contact preferences for a valid token (200, ok:true)', async () => {
		const t = setupTest();
		const contactId = await seedContact(t, { email: 'pref-user@example.com' });
		const token = await makePrefToken(contactId);

		const res = await t.fetch(`/prefs/verify/${encodeURIComponent(token)}`, { method: 'GET' });
		// Outcome mode is always HTTP 200.
		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean; data: { email: string } };
		expect(json.ok).toBe(true);
		expect(json.data.email).toBe('pref-user@example.com');
	});

	it('returns ok:false for a bogus token (still HTTP 200, outcome mode)', async () => {
		const t = setupTest();
		const res = await t.fetch(`/prefs/verify/${encodeURIComponent('garbage')}`, {
			method: 'GET',
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean; reason: string };
		expect(json.ok).toBe(false);
		expect(json.reason).toBeDefined();
	});

	it('rejects an unsubscribe-token reused on the prefs endpoint (wrong prefix)', async () => {
		const t = setupTest();
		const contactId = await seedContact(t);
		// A valid UNSUBSCRIBE token (no `pref:` prefix) must NOT verify as a
		// preference token — the prefix binds the two token families apart.
		const unsubToken = await makeUnsubToken(contactId);

		const res = await t.fetch(`/prefs/verify/${encodeURIComponent(unsubToken)}`, {
			method: 'GET',
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean; reason: string };
		expect(json.ok).toBe(false);
		expect(json.reason).toBe('invalid_signature');
	});
});

describe('updatePreferences (POST /prefs/update/...)', () => {
	it('updates preferences for a valid token (200, ok:true)', async () => {
		const t = setupTest();
		const contactId = await seedContact(t);
		const token = await makePrefToken(contactId);

		const res = await t.fetch(`/prefs/update/${encodeURIComponent(token)}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean; data: { message: string } };
		expect(json.ok).toBe(true);
	});

	it('rejects a bogus token (400)', async () => {
		const t = setupTest();
		const res = await t.fetch(`/prefs/update/${encodeURIComponent('nope')}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it('rejects a non-array topicUpdates payload (400) for a valid token', async () => {
		const t = setupTest();
		const contactId = await seedContact(t);
		const token = await makePrefToken(contactId);

		const res = await t.fetch(`/prefs/update/${encodeURIComponent(token)}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ topicUpdates: 'not-an-array' }),
		});
		expect(res.status).toBe(400);
	});

	it('rejects a non-boolean globalUnsubscribe payload (400) for a valid token', async () => {
		const t = setupTest();
		const contactId = await seedContact(t);
		const token = await makePrefToken(contactId);

		const res = await t.fetch(`/prefs/update/${encodeURIComponent(token)}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ globalUnsubscribe: 'yes' }),
		});
		expect(res.status).toBe(400);
	});

	it('globalUnsubscribe:true removes the contact from every topic (200, ok:true)', async () => {
		const t = setupTest();
		const contactId = await seedContact(t);
		const token = await makePrefToken(contactId);

		// Seed two topics and subscribe the contact to both.
		const now = Date.now();
		await t.run(async (ctx) => {
			for (const name of ['Alpha', 'Beta']) {
				const topicId = await ctx.db.insert(
					'topics',
					createTestTopic({ name }) as never,
				);
				await ctx.db.insert('contactTopics', {
					contactId,
					topicId,
					addedAt: now,
				} as never);
			}
		});

		const res = await t.fetch(`/prefs/update/${encodeURIComponent(token)}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ globalUnsubscribe: true }),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean };
		expect(json.ok).toBe(true);

		// Every membership for this contact is gone.
		const remaining = await t.run(async (ctx) =>
			ctx.db
				.query('contactTopics')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect(),
		);
		expect(remaining).toHaveLength(0);
	});
});

// ============================================================================
// Seed admin — POST /seed/admin
// ============================================================================

describe('seedAdmin (POST /seed/admin)', () => {
	const BODY = JSON.stringify({
		email: 'admin@example.com',
		name: 'Admin',
		passwordHash: 'hashed-password',
	});

	it('rejects (401) when the X-Instance-Secret header is missing', async () => {
		const t = setupTest();
		const res = await t.fetch('/seed/admin', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: BODY,
		});
		expect(res.status).toBe(401);
	});

	it('rejects (401) when the X-Instance-Secret header is wrong', async () => {
		const t = setupTest();
		const res = await t.fetch('/seed/admin', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Instance-Secret': 'wrong-secret',
			},
			body: BODY,
		});
		expect(res.status).toBe(401);
	});

	it('rejects (401) when INSTANCE_SECRET is unset on the server, even with a header', async () => {
		delete process.env['INSTANCE_SECRET'];
		const t = setupTest();
		const res = await t.fetch('/seed/admin', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Instance-Secret': 'anything',
			},
			body: BODY,
		});
		expect(res.status).toBe(401);
	});

	it('rejects (400) with a valid secret but missing required fields', async () => {
		const t = setupTest();
		const res = await t.fetch('/seed/admin', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Instance-Secret': 'test-instance-secret',
			},
			body: JSON.stringify({ email: 'admin@example.com' }),
		});
		expect(res.status).toBe(400);
	});

	// HARNESS LIMITATION (not a product bug): the success path calls
	// `components.betterAuth.adapter.{findMany,create}`, and the betterAuth
	// component is not registered in convex-test (only the rateLimiter is).
	// `t.registerComponent` would need the betterAuth component's module map,
	// which isn't wired into the test harness. The auth-gate (401/400) cases
	// above cover the security-relevant surface of this endpoint.
	it.skip('seeds once with the correct secret, then refuses a second call (one-shot)', async () => {
		const t = setupTest();
		const first = await t.fetch('/seed/admin', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Instance-Secret': 'test-instance-secret',
			},
			body: BODY,
		});
		expect(first.status).toBe(201);

		const second = await t.fetch('/seed/admin', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Instance-Secret': 'test-instance-secret',
			},
			body: BODY,
		});
		// One-shot guard: a user already exists → 409.
		expect(second.status).toBe(409);
	});
});
