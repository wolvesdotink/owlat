import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
	CORE_SEND_PROVIDER_CATALOG_ENTRIES,
	type CoreSendProviderCatalogEntry,
} from '@owlat/shared';
import { PROVIDER_FEEDBACK_CONTRIBUTIONS } from '../../providers/feedback';
import { verifyProviderFeedbackRequest } from '../providerVerifierRegistry';

const SAVED_ENV = { ...process.env };

afterEach(() => {
	process.env = { ...SAVED_ENV };
});

const NOW_SECONDS = () => Math.floor(Date.now() / 1_000);

describe('provider verifier registry', () => {
	it.each([
		['sha256', 'hex'],
		['sha256', 'base64'],
		['sha1', 'hex'],
		['sha1', 'base64'],
	] as const)('verifies timestamp-bound %s/%s HMAC', async (algorithm, encoding) => {
		process.env['MTA_WEBHOOK_SECRET'] = 'registry-secret';
		const timestamp = `${NOW_SECONDS()}`;
		const body = '{"event":"test"}';
		const signature = createHmac(algorithm, 'registry-secret')
			.update(`${timestamp}.${body}`)
			.digest(encoding);
		const result = await verifyProviderFeedbackRequest(
			new Request('https://example.test/webhook', {
				headers: { 'x-signature': signature, 'x-timestamp': timestamp },
			}),
			body,
			{
				scheme: 'hmac-timestamp-body',
				algorithm,
				encoding,
				signatureHeader: 'x-signature',
				timestampHeader: 'x-timestamp',
				secretEnvVar: 'MTA_WEBHOOK_SECRET',
				toleranceSeconds: 300,
			}
		);
		expect(result).toEqual({ ok: true });
	});

	it('fails closed before comparison when the secret is absent', async () => {
		delete process.env['MTA_WEBHOOK_SECRET'];
		const result = await verifyProviderFeedbackRequest(
			new Request('https://example.test/webhook'),
			'{}',
			{
				scheme: 'hmac-timestamp-body',
				algorithm: 'sha256',
				encoding: 'hex',
				signatureHeader: 'x-signature',
				timestampHeader: 'x-timestamp',
				secretEnvVar: 'MTA_WEBHOOK_SECRET',
				toleranceSeconds: 300,
			}
		);
		expect(result).toMatchObject({ ok: false, status: 503 });
	});
});

/**
 * The timestamp is the whole of this scheme's replay resistance, so what counts
 * AS a timestamp is a security decision — and it is the one the two enforcers of
 * this scheme used to disagree about. The plugin inbound path required ASCII
 * digits; this registry accepted anything `Number()` could read, which is a
 * wider language than any sender writes.
 *
 * Every case below is signed CORRECTLY over the exact header bytes, so the only
 * thing that can reject it is the format gate — and every one of them coerces to
 * a perfectly current instant, so the freshness check cannot reject it either.
 * Before the gate they all verified.
 */
describe('the registry accepts only digits as a timestamp', () => {
	const BODY = '{"event":"bounced"}';
	const SECRET = 'registry-secret';

	function signedRequest(timestamp: string): Request {
		const signature = createHmac('sha256', SECRET).update(`${timestamp}.${BODY}`).digest('hex');
		return new Request('https://example.test/webhook', {
			headers: { 'x-signature': signature, 'x-timestamp': timestamp },
		});
	}

	async function verdict(timestamp: string) {
		process.env['MTA_WEBHOOK_SECRET'] = SECRET;
		return verifyProviderFeedbackRequest(signedRequest(timestamp), BODY, {
			scheme: 'hmac-timestamp-body',
			algorithm: 'sha256',
			encoding: 'hex',
			signatureHeader: 'x-signature',
			timestampHeader: 'x-timestamp',
			secretEnvVar: 'MTA_WEBHOOK_SECRET',
			toleranceSeconds: 300,
		});
	}

	it.each([
		['a trailing fraction', () => `${NOW_SECONDS()}.0`],
		['exponent notation', () => `${NOW_SECONDS()}e0`],
		['hexadecimal', () => `0x${NOW_SECONDS().toString(16)}`],
		['a leading plus', () => `+${NOW_SECONDS()}`],
	])('rejects %s, correctly signed and numerically current', async (_label, timestamp) => {
		expect(await verdict(timestamp())).toMatchObject({
			ok: false,
			status: 401,
			reason: 'Invalid or expired signature timestamp',
		});
	});

	it('rejects a negative timestamp', async () => {
		expect(await verdict(`-${NOW_SECONDS()}`)).toMatchObject({ ok: false, status: 401 });
	});

	it('still accepts the plain digits a sender actually writes', async () => {
		expect(await verdict(`${NOW_SECONDS()}`)).toEqual({ ok: true });
	});
});

/**
 * A tolerance reaches this registry from a bundle or, through
 * `providers/feedback.ts:pluginVerifier`, from a plugin manifest — declared data
 * either way. Enforcing it unbounded would let a declaration hand itself an
 * arbitrarily long replay window.
 */
describe('the registry clamps the tolerance it was declared', () => {
	const BODY = '{"event":"bounced"}';
	const SECRET = 'registry-secret';

	async function verdict(timestamp: string, toleranceSeconds: number) {
		process.env['MTA_WEBHOOK_SECRET'] = SECRET;
		const signature = createHmac('sha256', SECRET).update(`${timestamp}.${BODY}`).digest('hex');
		return verifyProviderFeedbackRequest(
			new Request('https://example.test/webhook', {
				headers: { 'x-signature': signature, 'x-timestamp': timestamp },
			}),
			BODY,
			{
				scheme: 'hmac-timestamp-body',
				algorithm: 'sha256',
				encoding: 'hex',
				signatureHeader: 'x-signature',
				timestampHeader: 'x-timestamp',
				secretEnvVar: 'MTA_WEBHOOK_SECRET',
				toleranceSeconds,
			}
		);
	}

	it('refuses an hour-old capture a declaration claimed a year for', async () => {
		expect(await verdict(`${NOW_SECONDS() - 3_600}`, 31_536_000)).toMatchObject({
			ok: false,
			status: 401,
			reason: 'Invalid or expired signature timestamp',
		});
	});

	it('does not let a zero or negative declaration reject everything', async () => {
		// Clamped UP to one second: a typo in a manifest is an outage otherwise.
		expect(await verdict(`${NOW_SECONDS()}`, 0)).toEqual({ ok: true });
		expect(await verdict(`${NOW_SECONDS()}`, -300)).toEqual({ ok: true });
	});
});

/**
 * Svix's scheme is verified by the same inner helper the Resend adapter has
 * always used, but the WINDOW is now the one the bundle declares rather than a
 * constant inside that helper which happened to agree with it. Both directions
 * are pinned: a declaration narrower than the old constant must reject inside
 * it, and a wider one must accept outside it.
 */
describe('the registry enforces the tolerance a svix bundle declares', () => {
	const SECRET_BASE64 = 'YWJjZGVmZ2hpamtsbW5vcA==';
	const BODY = '{"type":"email.bounced","data":{"email_id":"em_123"}}';
	const SVIX_ID = 'msg_registry_1';

	function svixRequest(timestamp: string): Request {
		const signature = createHmac('sha256', Buffer.from(SECRET_BASE64, 'base64'))
			.update(`${SVIX_ID}.${timestamp}.${BODY}`)
			.digest('base64');
		return new Request('https://example.test/webhooks/resend', {
			headers: {
				'svix-id': SVIX_ID,
				'svix-timestamp': timestamp,
				'svix-signature': `v1,${signature}`,
			},
		});
	}

	async function verdict(ageSeconds: number, toleranceSeconds: number) {
		process.env['RESEND_WEBHOOK_SECRET'] = `whsec_${SECRET_BASE64}`;
		const timestamp = `${NOW_SECONDS() - ageSeconds}`;
		return verifyProviderFeedbackRequest(svixRequest(timestamp), BODY, {
			scheme: 'svix',
			secretEnvVar: 'RESEND_WEBHOOK_SECRET',
			toleranceSeconds,
		});
	}

	it('accepts inside the declared window', async () => {
		expect(await verdict(30, 60)).toEqual({ ok: true });
	});

	it('rejects outside a window NARROWER than the helper’s own default', async () => {
		// 120s old against a declared 60s. The unthreaded helper compared against
		// its hardcoded 300 and accepted this.
		expect(await verdict(120, 60)).toMatchObject({
			ok: false,
			status: 401,
			reason: 'Invalid signature',
		});
	});

	it('accepts inside a window WIDER than the helper’s own default', async () => {
		// 400s old against a declared 600s: the declaration is what is enforced,
		// not a constant that agrees with today's only bundle.
		expect(await verdict(400, 600)).toEqual({ ok: true });
	});

	it('clamps a declared svix window to the same ceiling', async () => {
		expect(await verdict(3_600, 31_536_000)).toMatchObject({ ok: false, status: 401 });
	});

	it('fails closed when the svix secret is absent', async () => {
		delete process.env['RESEND_WEBHOOK_SECRET'];
		const result = await verifyProviderFeedbackRequest(svixRequest(`${NOW_SECONDS()}`), BODY, {
			scheme: 'svix',
			secretEnvVar: 'RESEND_WEBHOOK_SECRET',
			toleranceSeconds: 300,
		});
		expect(result).toMatchObject({ ok: false, status: 503 });
	});
});

/**
 * The registry cases above declare their own verifier, which proves the SCHEMES.
 * It cannot prove that the contribution a live route dispatches through names
 * the headers and the secret the provider actually signs with — a contribution
 * that named `x-signature` instead of `x-mta-signature` would pass every case
 * above and reject every real webhook, and the rejection-path suites
 * (`adapterRegistry.test.ts`) would still be green because a wrong header name
 * rejects exactly like a missing one.
 *
 * So this signs an ACCEPTANCE through the shipped contribution.
 */
describe('the shipped MTA contribution accepts a request signed the way the MTA signs it', () => {
	const SECRET = 'mta-shared-webhook-secret';
	const BODY = '{"event":"bounced","messageId":"m_1","timestamp":1770000000000}';

	function mtaContribution() {
		const entry = PROVIDER_FEEDBACK_CONTRIBUTIONS.find(({ kind }) => kind === 'mta');
		expect(entry, 'the mta feedback contribution is not registered').toBeDefined();
		return entry!.contribution;
	}

	it('verifies the real x-mta-signature / x-mta-timestamp pair', async () => {
		process.env['MTA_WEBHOOK_SECRET'] = SECRET;
		const timestamp = `${NOW_SECONDS()}`;
		const signature = createHmac('sha256', SECRET).update(`${timestamp}.${BODY}`).digest('hex');
		const result = await verifyProviderFeedbackRequest(
			new Request('https://example.convex.site/webhooks/mta', {
				method: 'POST',
				headers: { 'x-mta-signature': signature, 'x-mta-timestamp': timestamp },
			}),
			BODY,
			mtaContribution().verifier
		);
		expect(result).toEqual({ ok: true });
	});

	it('rejects the same body under the wrong secret', async () => {
		process.env['MTA_WEBHOOK_SECRET'] = SECRET;
		const timestamp = `${NOW_SECONDS()}`;
		const signature = createHmac('sha256', 'not-the-secret')
			.update(`${timestamp}.${BODY}`)
			.digest('hex');
		const result = await verifyProviderFeedbackRequest(
			new Request('https://example.convex.site/webhooks/mta', {
				method: 'POST',
				headers: { 'x-mta-signature': signature, 'x-mta-timestamp': timestamp },
			}),
			BODY,
			mtaContribution().verifier
		);
		expect(result).toMatchObject({ ok: false, status: 401 });
	});
});

/**
 * One declaration of the signing key, or two that are checked against each
 * other. The catalog's `signingKeyEnvVar` is what the delivery UI tells an
 * operator to set and what the feedback-status query reports as configured; the
 * verifier's `secretEnvVar` is what actually gets read. Drift between them is
 * silent in the worst direction — a verifier reading ANOTHER declared provider's
 * secret finds a value in a fully configured deployment, so it rejects live
 * traffic while every "is it configured?" surface says yes.
 *
 * `providers/feedback.ts` throws on that at module load. This states the fact
 * the throw defends, so a failure names the provider rather than the import.
 */
describe('a contribution reads the key the catalog declares', () => {
	const entries: readonly CoreSendProviderCatalogEntry[] = CORE_SEND_PROVIDER_CATALOG_ENTRIES;
	const declared = entries.filter((entry) => entry.providerFeedback !== undefined);

	it('has subjects at all', () => {
		expect(declared.length).toBeGreaterThan(1);
	});

	it.each(declared.map((entry) => entry.kind))('%s', (kind) => {
		const entry = declared.find((candidate) => candidate.kind === kind)!;
		const contribution = PROVIDER_FEEDBACK_CONTRIBUTIONS.find(
			(candidate) => candidate.kind === kind
		)?.contribution;
		expect(contribution, `${kind} declares feedback but contributes none`).toBeDefined();
		const { verifier } = contribution!;
		// `aws-sns` is the one scheme with no shared key: SNS signs with a rotating
		// certificate it names in the message, so the catalog declares no
		// `signingKeyEnvVar` and the verifier declares a topic ARN instead. Both
		// spellings of "no key" have to agree too.
		expect(verifier.scheme === 'aws-sns' ? undefined : verifier.secretEnvVar).toBe(
			entry.providerFeedback?.signingKeyEnvVar
		);
	});
});
