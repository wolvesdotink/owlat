import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import rateLimiterTest from '@convex-dev/rate-limiter/test';

/**
 * Signature / secret-verification tests for the webhook handlers NOT covered by
 * channelWebhooks.integration.test.ts (which handles sms/whatsapp/generic).
 *
 * Covered here:
 *   - POST /webhooks/github               (webhooks/githubHttp.ts handleGithubWebhook)
 *   - POST /webhooks/mta-verify-credential (mail/authHttp.ts handleVerifyCredential)
 *   - POST /webhooks/mta-mailbox          (mail/webhook.ts handleMailWebhook)
 *
 * Each handler verifies an HMAC over the raw body before doing any work, so we
 * assert the exact reject statuses (503 missing secret, 401 missing/bad sig,
 * 401 stale timestamp) and the 2xx accept path, and that no observable state
 * mutation happens on a rejected request.
 *
 * Schemes (read from source, mirrored byte-for-byte below):
 *   github:               header `x-hub-signature-256: sha256=` + hex(HMAC-SHA256(secret, body))
 *   mta-verify-credential: headers `x-mta-signature` = hex(HMAC-SHA256(secret, `<ts>.<body>`)),
 *                          `x-mta-timestamp` = unix-seconds; staleness window ±60s
 *   mta-mailbox:          same scheme via verifyMtaHeaders, staleness window ±300s
 */

// Standard module glob (agent / LLM modules excluded — they need extra mocks).
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
			!p.includes('llmProvider')
	)
);

function setupTest() {
	const t = convexTest(schema, modules);
	// Every one of these handlers rate-limits before sig verification (mta-*)
	// or routes through http.ts, so the rate-limiter component must be live.
	rateLimiterTest.register(t);
	return t;
}

// HMAC-SHA256 → lowercase hex, mirroring webhooks/security.ts:hmacSha256Hex
// and the inline helper in mail/authHttp.ts.
async function hmacSha256Hex(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

const GITHUB_PATH = '/webhooks/github';
const VERIFY_PATH = '/webhooks/mta-verify-credential';
const MAILBOX_PATH = '/webhooks/mta-mailbox';

const SAVED_ENV = { ...process.env };

beforeEach(() => {
	process.env['GITHUB_WEBHOOK_SECRET'] = 'gh-test-secret';
	process.env['MTA_WEBHOOK_SECRET'] = 'mta-test-secret';
	// Make the per-IP rate-limit key deterministic across tests (getClientIp
	// returns 'unknown' when this is unset, which is fine — kept explicit).
	delete process.env['RATE_LIMIT_TRUSTED_PROXY'];
});

afterEach(() => {
	process.env = { ...SAVED_ENV };
});

// ─── GitHub PR-merge webhook ──────────────────────────────────────────────

describe('handleGithubWebhook (/webhooks/github)', () => {
	const PING_BODY = JSON.stringify({ zen: 'Keep it logically awesome.' });

	it('rejects (503) when GITHUB_WEBHOOK_SECRET is unset', async () => {
		delete process.env['GITHUB_WEBHOOK_SECRET'];
		const t = setupTest();
		const res = await t.fetch(GITHUB_PATH, {
			method: 'POST',
			body: PING_BODY,
			headers: { 'Content-Type': 'application/json' },
		});
		expect(res.status).toBe(503);
	});

	it('rejects (401) when the signature header is missing', async () => {
		const t = setupTest();
		const res = await t.fetch(GITHUB_PATH, {
			method: 'POST',
			body: PING_BODY,
			headers: { 'Content-Type': 'application/json' },
		});
		expect(res.status).toBe(401);
	});

	it('rejects (401) when the signature is wrong', async () => {
		const t = setupTest();
		const res = await t.fetch(GITHUB_PATH, {
			method: 'POST',
			body: PING_BODY,
			headers: {
				'Content-Type': 'application/json',
				'x-hub-signature-256': 'sha256=deadbeef',
			},
		});
		expect(res.status).toBe(401);
	});

	it('rejects (401) when the signature has no sha256= prefix even if hex matches', async () => {
		const t = setupTest();
		// Correct HMAC hex, but missing the required `sha256=` prefix.
		const hex = await hmacSha256Hex('gh-test-secret', PING_BODY);
		const res = await t.fetch(GITHUB_PATH, {
			method: 'POST',
			body: PING_BODY,
			headers: {
				'Content-Type': 'application/json',
				'x-hub-signature-256': hex,
			},
		});
		expect(res.status).toBe(401);
	});

	it('accepts (200) a correctly-signed non-pull_request event', async () => {
		const t = setupTest();
		const sig = await hmacSha256Hex('gh-test-secret', PING_BODY);
		const res = await t.fetch(GITHUB_PATH, {
			method: 'POST',
			body: PING_BODY,
			headers: {
				'Content-Type': 'application/json',
				'x-hub-signature-256': `sha256=${sig}`,
				'x-github-event': 'ping',
			},
		});
		// Valid signature but event we don't track → acknowledged 200 (no retry).
		expect(res.status).toBe(200);
	});

	it('accepts (200) and marks the matching task merged on a valid pull_request merge', async () => {
		const t = setupTest();
		const PR_URL = 'https://github.com/acme/repo/pull/42';

		const taskId = await t.run(async (ctx) =>
			ctx.db.insert('codeWorkTasks', {
				description: 'do the thing',
				prUrl: PR_URL,
				status: 'review',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})
		);

		const body = JSON.stringify({
			action: 'closed',
			pull_request: { merged: true, html_url: PR_URL },
		});
		const sig = await hmacSha256Hex('gh-test-secret', body);

		const res = await t.fetch(GITHUB_PATH, {
			method: 'POST',
			body,
			headers: {
				'Content-Type': 'application/json',
				'x-hub-signature-256': `sha256=${sig}`,
				'x-github-event': 'pull_request',
			},
		});
		expect(res.status).toBe(200);

		const task = await t.run(async (ctx) => ctx.db.get(taskId));
		expect(task?.status).toBe('merged');
	});

	it('does NOT mutate the task when the signature is invalid', async () => {
		const t = setupTest();
		const PR_URL = 'https://github.com/acme/repo/pull/99';

		const taskId = await t.run(async (ctx) =>
			ctx.db.insert('codeWorkTasks', {
				description: 'untouched',
				prUrl: PR_URL,
				status: 'review',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})
		);

		const body = JSON.stringify({
			action: 'closed',
			pull_request: { merged: true, html_url: PR_URL },
		});

		const res = await t.fetch(GITHUB_PATH, {
			method: 'POST',
			body,
			headers: {
				'Content-Type': 'application/json',
				// Wrong signature — body would otherwise mark the task merged.
				'x-hub-signature-256': 'sha256=00',
				'x-github-event': 'pull_request',
			},
		});
		expect(res.status).toBe(401);

		const task = await t.run(async (ctx) => ctx.db.get(taskId));
		expect(task?.status).toBe('review');
	});
});

// ─── MTA verify-credential webhook ─────────────────────────────────────────

describe('handleVerifyCredential (/webhooks/mta-verify-credential)', () => {
	const VERIFY_BODY = JSON.stringify({
		address: 'user@example.com',
		password: 'app-pw',
		scope: 'imap',
	});

	function signedHeaders(ts: number, body: string, sigHex: string) {
		return {
			'Content-Type': 'application/json',
			'x-mta-signature': sigHex,
			'x-mta-timestamp': String(ts),
		};
	}

	it('rejects (503) when MTA_WEBHOOK_SECRET is unset', async () => {
		delete process.env['MTA_WEBHOOK_SECRET'];
		const t = setupTest();
		const ts = nowSeconds();
		const sig = await hmacSha256Hex('whatever', `${ts}.${VERIFY_BODY}`);
		const res = await t.fetch(VERIFY_PATH, {
			method: 'POST',
			body: VERIFY_BODY,
			headers: signedHeaders(ts, VERIFY_BODY, sig),
		});
		expect(res.status).toBe(503);
	});

	it('rejects (401) when the signature header is missing', async () => {
		const t = setupTest();
		const res = await t.fetch(VERIFY_PATH, {
			method: 'POST',
			body: VERIFY_BODY,
			headers: {
				'Content-Type': 'application/json',
				'x-mta-timestamp': String(nowSeconds()),
			},
		});
		expect(res.status).toBe(401);
	});

	it('rejects (401) when the timestamp header is missing', async () => {
		const t = setupTest();
		const sig = await hmacSha256Hex(
			'mta-test-secret',
			`${nowSeconds()}.${VERIFY_BODY}`
		);
		const res = await t.fetch(VERIFY_PATH, {
			method: 'POST',
			body: VERIFY_BODY,
			headers: {
				'Content-Type': 'application/json',
				'x-mta-signature': sig,
			},
		});
		expect(res.status).toBe(401);
	});

	it('rejects (401) when the timestamp is stale (>60s)', async () => {
		const t = setupTest();
		const staleTs = nowSeconds() - 120; // outside the ±60s window
		// A perfectly valid HMAC for the stale timestamp — still rejected on age.
		const sig = await hmacSha256Hex('mta-test-secret', `${staleTs}.${VERIFY_BODY}`);
		const res = await t.fetch(VERIFY_PATH, {
			method: 'POST',
			body: VERIFY_BODY,
			headers: signedHeaders(staleTs, VERIFY_BODY, sig),
		});
		expect(res.status).toBe(401);
	});

	it('rejects (401) when the timestamp is not a number', async () => {
		const t = setupTest();
		const sig = await hmacSha256Hex('mta-test-secret', `notanumber.${VERIFY_BODY}`);
		const res = await t.fetch(VERIFY_PATH, {
			method: 'POST',
			body: VERIFY_BODY,
			headers: {
				'Content-Type': 'application/json',
				'x-mta-signature': sig,
				'x-mta-timestamp': 'notanumber',
			},
		});
		expect(res.status).toBe(401);
	});

	it('rejects (401) when the signature is wrong', async () => {
		const t = setupTest();
		const ts = nowSeconds();
		const res = await t.fetch(VERIFY_PATH, {
			method: 'POST',
			body: VERIFY_BODY,
			headers: signedHeaders(ts, VERIFY_BODY, 'beef'),
		});
		expect(res.status).toBe(401);
	});

	it('accepts (200) a fresh, correctly-signed request (returns ok:false when no mailbox)', async () => {
		const t = setupTest();
		const ts = nowSeconds();
		const sig = await hmacSha256Hex('mta-test-secret', `${ts}.${VERIFY_BODY}`);
		const res = await t.fetch(VERIFY_PATH, {
			method: 'POST',
			body: VERIFY_BODY,
			headers: signedHeaders(ts, VERIFY_BODY, sig),
		});
		// Signature passes → handler dispatches to mail.appPasswords.verify.
		// With no seeded mailbox the verify returns null → { ok:false } at 200.
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json).toEqual({ ok: false });
	});

	it('rejects (405) on a non-POST method', async () => {
		const t = setupTest();
		const res = await t.fetch(VERIFY_PATH, { method: 'GET' });
		// Routed POST-only in http.ts, but the handler also guards method.
		// The router rejects unmatched method before the handler — accept either
		// the handler's 405 or the router's 404.
		expect([404, 405]).toContain(res.status);
	});
});

// ─── MTA mailbox (Postbox inbound) webhook ─────────────────────────────────

describe('handleMailWebhook (/webhooks/mta-mailbox)', () => {
	function mailBody(overrides: Record<string, unknown> = {}): string {
		return JSON.stringify({
			event: 'inbound.mailbox.received',
			timestamp: Date.now(),
			mailboxPayload: {
				deliveryId: 'd-1',
				recipientAddress: 'inbox@example.com',
				rawBytesBase64: '',
				from: 'sender@example.com',
				to: ['inbox@example.com'],
				subject: 'hi',
				messageId: 'm-1',
			},
			...overrides,
		});
	}

	async function countPayloads(t: ReturnType<typeof setupTest>): Promise<number> {
		return t.run(async (ctx) => {
			const rows = await ctx.db.query('webhookPayloads').collect();
			return rows.length;
		});
	}

	it('rejects (503) when MTA_WEBHOOK_SECRET is unset', async () => {
		delete process.env['MTA_WEBHOOK_SECRET'];
		const t = setupTest();
		const body = mailBody();
		const ts = nowSeconds();
		const sig = await hmacSha256Hex('whatever', `${ts}.${body}`);
		const res = await t.fetch(MAILBOX_PATH, {
			method: 'POST',
			body,
			headers: {
				'Content-Type': 'application/json',
				'x-mta-signature': sig,
				'x-mta-timestamp': String(ts),
			},
		});
		expect(res.status).toBe(503);
		expect(await countPayloads(t)).toBe(0);
	});

	it('rejects (401) when signature headers are missing', async () => {
		const t = setupTest();
		const res = await t.fetch(MAILBOX_PATH, {
			method: 'POST',
			body: mailBody(),
			headers: { 'Content-Type': 'application/json' },
		});
		expect(res.status).toBe(401);
		expect(await countPayloads(t)).toBe(0);
	});

	it('rejects (401) when the signature is wrong (and stores no payload)', async () => {
		const t = setupTest();
		const body = mailBody();
		const ts = nowSeconds();
		const res = await t.fetch(MAILBOX_PATH, {
			method: 'POST',
			body,
			headers: {
				'Content-Type': 'application/json',
				'x-mta-signature': 'deadbeef',
				'x-mta-timestamp': String(ts),
			},
		});
		expect(res.status).toBe(401);
		// Audit-store of the raw payload only happens after the signature passes.
		expect(await countPayloads(t)).toBe(0);
	});

	it('rejects (401) when the timestamp is stale (>300s)', async () => {
		const t = setupTest();
		const body = mailBody();
		const staleTs = nowSeconds() - 600; // outside the ±300s window
		const sig = await hmacSha256Hex('mta-test-secret', `${staleTs}.${body}`);
		const res = await t.fetch(MAILBOX_PATH, {
			method: 'POST',
			body,
			headers: {
				'Content-Type': 'application/json',
				'x-mta-signature': sig,
				'x-mta-timestamp': String(staleTs),
			},
		});
		expect(res.status).toBe(401);
		expect(await countPayloads(t)).toBe(0);
	});

	it('passes signature verification and stores the audit payload on a valid request', async () => {
		const t = setupTest();
		const body = mailBody();
		const ts = nowSeconds();
		const sig = await hmacSha256Hex('mta-test-secret', `${ts}.${body}`);
		const res = await t.fetch(MAILBOX_PATH, {
			method: 'POST',
			body,
			headers: {
				'Content-Type': 'application/json',
				'x-mta-signature': sig,
				'x-mta-timestamp': String(ts),
			},
		});
		// Signature verifies → handler audit-stores then dispatches to
		// mail.delivery.ingestFromWebhook. Dispatch may succeed (200) or fail
		// (500) depending on downstream state, but it is NOT a signature reject.
		expect(res.status).not.toBe(401);
		expect(res.status).not.toBe(503);
		// The raw payload is audit-stored regardless of dispatch outcome,
		// proving signature verification passed (it never stores on reject).
		expect(await countPayloads(t)).toBe(1);
	});

	it('rejects (400) a correctly-signed body with an unsupported event', async () => {
		const t = setupTest();
		const body = mailBody({ event: 'inbound.something.else' });
		const ts = nowSeconds();
		const sig = await hmacSha256Hex('mta-test-secret', `${ts}.${body}`);
		const res = await t.fetch(MAILBOX_PATH, {
			method: 'POST',
			body,
			headers: {
				'Content-Type': 'application/json',
				'x-mta-signature': sig,
				'x-mta-timestamp': String(ts),
			},
		});
		expect(res.status).toBe(400);
		// Past signature verification, so the payload was still audit-stored.
		expect(await countPayloads(t)).toBe(1);
	});
});
