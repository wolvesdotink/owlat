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
 *   - POST /webhooks/mta-mailbox          (mail/webhookHttp.ts handleMailWebhook)
 *   - POST /webhooks/mta-inbound          (inbox/inboundWebhookHttp.ts handleInboundWebhook)
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
 *   mta-inbound:          same scheme via verifyMtaHeaders, staleness window ±300s
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
const INBOUND_PATH = '/webhooks/mta-inbound';
const PIPELINE_PATH = '/webhooks/mta';

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
		const sig = await hmacSha256Hex('mta-test-secret', `${nowSeconds()}.${VERIFY_BODY}`);
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

	it('does not let unsigned traffic spend the bucket the real MTA shares', async () => {
		const t = setupTest();
		// `webhookIngestion` holds 100 tokens, and without
		// RATE_LIMIT_TRUSTED_PROXY every caller keys as the same 'unknown' IP —
		// so charging before the signature check let anyone 429 the MTA's next
		// signed delivery, which it retries six times and then dead-letters.
		for (let i = 0; i < 120; i++) {
			const res = await t.fetch(MAILBOX_PATH, {
				method: 'POST',
				body: mailBody(),
				headers: { 'Content-Type': 'application/json' },
			});
			expect(res.status).toBe(401);
		}

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
		expect(res.status).not.toBe(429);
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

// ─── MTA inbound (team / AI shared inbox) webhook ──────────────────────────

describe('handleInboundWebhook (/webhooks/mta-inbound)', () => {
	function inboundBody(
		overrides: Record<string, unknown> = {},
		payloadOverrides: Record<string, unknown> = {}
	): string {
		return JSON.stringify({
			event: 'inbound.received',
			organizationId: 'org-1',
			timestamp: Date.now(),
			inboundPayload: {
				from: 'sender@example.com',
				to: 'inbox@example.com',
				subject: 'hi',
				textBody: 'hello',
				headers: {},
				messageId: '<inbound-sig-1@example.com>',
				attachments: [],
				...payloadOverrides,
			},
			...overrides,
		});
	}

	async function payloadRows(t: ReturnType<typeof setupTest>) {
		return t.run(async (ctx) => await ctx.db.query('webhookPayloads').collect());
	}

	async function countPayloads(t: ReturnType<typeof setupTest>): Promise<number> {
		return (await payloadRows(t)).length;
	}

	async function post(
		t: ReturnType<typeof setupTest>,
		path: string,
		body: string,
		headers: Record<string, string>
	) {
		return t.fetch(path, {
			method: 'POST',
			body,
			headers: { 'Content-Type': 'application/json', ...headers },
		});
	}

	async function signedHeaders(body: string, secret = 'mta-test-secret') {
		const ts = nowSeconds();
		return {
			'x-mta-signature': await hmacSha256Hex(secret, `${ts}.${body}`),
			'x-mta-timestamp': String(ts),
		};
	}

	it('rejects (503) when MTA_WEBHOOK_SECRET is unset', async () => {
		delete process.env['MTA_WEBHOOK_SECRET'];
		const t = setupTest();
		const body = inboundBody();
		const res = await post(t, INBOUND_PATH, body, await signedHeaders(body, 'whatever'));
		expect(res.status).toBe(503);
		expect(await countPayloads(t)).toBe(0);
	});

	it('rejects (401) when signature headers are missing', async () => {
		const t = setupTest();
		const res = await post(t, INBOUND_PATH, inboundBody(), {});
		expect(res.status).toBe(401);
		expect(await countPayloads(t)).toBe(0);
	});

	it('rejects (401) when the signature is wrong (and stores no payload)', async () => {
		const t = setupTest();
		const res = await post(t, INBOUND_PATH, inboundBody(), {
			'x-mta-signature': 'deadbeef',
			'x-mta-timestamp': String(nowSeconds()),
		});
		expect(res.status).toBe(401);
		// The audit row is only written after the signature passes.
		expect(await countPayloads(t)).toBe(0);
	});

	it("does not let junk that merely carries the headers spend the MTA's bucket", async () => {
		const t = setupTest();
		// `webhookIngestion` holds 100 tokens and, without
		// RATE_LIMIT_TRUSTED_PROXY, every caller keys as the same 'unknown' IP.
		// Refusing header-LESS requests for free was only half of it: setting
		// `X-MTA-Signature: whatever` costs an attacker nothing and used to
		// charge the bucket, so 120 such posts 429 the next genuine delivery —
		// which the MTA retries six times and then dead-letters.
		const junk = inboundBody();
		for (let i = 0; i < 120; i++) {
			const res = await post(t, INBOUND_PATH, junk, {
				'x-mta-signature': 'not-a-signature',
				'x-mta-timestamp': String(nowSeconds()),
				// The small DECLARED length is what buys the free verification.
				// A caller that declares none pays the bucket first, because
				// "no length" must never read as "a short body".
				'content-length': String(Buffer.byteLength(junk)),
			});
			expect(res.status).toBe(401);
		}

		const body = inboundBody();
		const res = await post(t, INBOUND_PATH, body, await signedHeaders(body));
		expect(res.status).not.toBe(429);
		expect(res.status).toBe(200);
	});

	it('rejects (401) when the timestamp is stale (>300s)', async () => {
		const t = setupTest();
		const body = inboundBody();
		const staleTs = nowSeconds() - 600;
		const res = await post(t, INBOUND_PATH, body, {
			'x-mta-signature': await hmacSha256Hex('mta-test-secret', `${staleTs}.${body}`),
			'x-mta-timestamp': String(staleTs),
		});
		expect(res.status).toBe(401);
		expect(await countPayloads(t)).toBe(0);
	});

	it('accepts a correctly signed body and stores the message', async () => {
		const t = setupTest();
		const body = inboundBody();
		const res = await post(t, INBOUND_PATH, body, await signedHeaders(body));
		expect(res.status).toBe(200);
		expect(await countPayloads(t)).toBe(1);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]!.messageId).toBe('<inbound-sig-1@example.com>');
	});

	it('rejects (400) a correctly-signed body with an unsupported event', async () => {
		const t = setupTest();
		const body = inboundBody({ event: 'inbound.something.else' });
		const res = await post(t, INBOUND_PATH, body, await signedHeaders(body));
		expect(res.status).toBe(400);
		// Past signature verification, so the audit row was still written.
		expect(await countPayloads(t)).toBe(1);
	});

	// ─── THE CAP BYPASS ──────────────────────────────────────────────────────
	//
	// The whole reason this route exists. The shared webhook pipeline rejects a
	// body over 5 MiB with 413 BEFORE authenticating it, and the MTA treats that
	// 413 as retryable — so a big message burns six delivery attempts and parks
	// in the DLQ. The standalone handler never imports the pipeline, so the same
	// bytes are accepted.
	it('accepts a ~6 MiB message the shared pipeline rejects with 413', async () => {
		const t = setupTest();
		// 6 MiB of raw message → roughly 8 MiB of base64 on the wire, comfortably
		// past the pipeline's 5 MiB cap in both directions.
		const rawBytes = 6 * 1024 * 1024;
		const rawEml = [
			'From: sender@example.com',
			'To: inbox@example.com',
			'Subject: big',
			'Message-ID: <inbound-big-1@example.com>',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'x'.repeat(rawBytes),
			'',
		].join('\r\n');
		const body = inboundBody(
			{},
			{
				messageId: '<inbound-big-1@example.com>',
				rawBytesBase64: Buffer.from(rawEml, 'latin1').toString('base64'),
			}
		);
		expect(body.length).toBeGreaterThan(5 * 1024 * 1024);

		const headers = await signedHeaders(body);
		const accepted = await post(t, INBOUND_PATH, body, headers);
		expect(accepted.status).toBe(200);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		// The bytes actually landed — this is the capability the route buys.
		expect(rows[0]!.rawStorageId).toBeTruthy();
		expect(rows[0]!.rawSize).toBe(rawEml.length);

		// The same signed bytes on the shared pipeline route: 413.
		const rejected = await post(t, PIPELINE_PATH, body, headers);
		expect(rejected.status).toBe(413);
	});

	// ─── THE ARGUMENT BUDGET ─────────────────────────────────────────────────
	//
	// Convex caps a function's ARGUMENTS at 16 MiB, and this route forwards the
	// base64 message AND the bodies the MTA already parsed out of it. Past the
	// budget the raw is what gets dropped — because `runAction` THROWS there,
	// the route answers 500, and the MTA burns six attempts on mail that was
	// perfectly deliverable. Only the pure predicate was covered, so replacing
	// the handler's `rawBytesBase64` with `payload.inboundPayload.rawBytesBase64`
	// passed every test in the repo while dead-lettering the message in
	// production.
	it('delivers a message over the argument budget WITHOUT its raw bytes', async () => {
		const t = setupTest();
		// Just past MAX_FORWARDED_ARG_BYTES (15 MiB) once the base64 message and
		// the parsed text body are added together — all ASCII, so characters are
		// bytes and the predicate's cheap bound decides it.
		const rawEml = [
			'From: sender@example.com',
			'To: inbox@example.com',
			'Subject: over budget',
			'Message-ID: <inbound-budget-1@example.com>',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'y'.repeat(12 * 1024 * 1024),
			'',
		].join('\r\n');
		const rawBytesBase64 = Buffer.from(rawEml, 'latin1').toString('base64');
		const textBody = 'z'.repeat(2 * 1024 * 1024);
		expect(rawBytesBase64.length + textBody.length).toBeGreaterThan(15 * 1024 * 1024);

		const body = inboundBody(
			{},
			{ messageId: '<inbound-budget-1@example.com>', rawBytesBase64, textBody }
		);
		const res = await post(t, INBOUND_PATH, body, await signedHeaders(body));

		// 200, not 500: the mail is delivered rather than dead-lettered.
		expect(res.status).toBe(200);
		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]!.messageId).toBe('<inbound-budget-1@example.com>');
		// THE BODIES WIN OVER THE BYTES. The row is stored with no raw blob —
		// exactly what the pre-raw route always delivered — so it has no
		// attachments and asserts no malware verdict.
		expect(rows[0]!.rawStorageId).toBeUndefined();
		expect(rows[0]!.rawSize).toBeUndefined();
		expect(rows[0]!.virusVerdict).toBeUndefined();
		expect(rows[0]!.textBody).toHaveLength(textBody.length);
	});

	it('audit-stores a digest of the body, never the message itself', async () => {
		const t = setupTest();
		const secretText = 'the-quick-brown-fox-jumps-over-the-lazy-dog';
		const rawEml = [
			'From: sender@example.com',
			'To: inbox@example.com',
			'Subject: audit',
			'Message-ID: <inbound-audit-1@example.com>',
			'Content-Type: text/plain; charset=utf-8',
			'',
			secretText,
			'',
		].join('\r\n');
		const rawBytesBase64 = Buffer.from(rawEml, 'latin1').toString('base64');
		const body = inboundBody({}, { messageId: '<inbound-audit-1@example.com>', rawBytesBase64 });

		const res = await post(t, INBOUND_PATH, body, await signedHeaders(body));
		expect(res.status).toBe(200);

		const rows = await payloadRows(t);
		expect(rows).toHaveLength(1);
		const stored = rows[0]!.rawPayload;
		// Not a second copy of the mail: neither the base64 nor its plaintext.
		expect(stored).not.toContain(rawBytesBase64);
		expect(stored).not.toContain(secretText);
		// A digest of the exact bytes the HMAC was verified over, plus the
		// envelope — which is what a delivery dispute actually asks about.
		const summary = JSON.parse(stored) as Record<string, unknown>;
		expect(summary['event']).toBe('inbound.received');
		expect(summary['bodyChars']).toBe(body.length);
		expect(summary['bodySha256']).toMatch(/^[0-9a-f]{64}$/);
		expect(summary['messageId']).toBe('<inbound-audit-1@example.com>');
		expect(summary['rawMessageBytes']).toBe(rawEml.length);
		// Well under Convex's 1 MiB document limit, which is the failure the
		// verbatim shape used to hit silently.
		expect(stored.length).toBeLessThan(4096);
	});
});
