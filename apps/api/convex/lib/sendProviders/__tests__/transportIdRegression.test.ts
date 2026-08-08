/**
 * P2-2 (c) — REGRESSION PROOF for a single-transport deployment.
 *
 * The whole refactor is meant to be semantics-preserving for the shipped
 * configuration: one transport per kind, reading the unsuffixed variables.
 * The existing dispatch / route / strategy / health suites still run unchanged
 * and are the primary proof; this file pins the specific invariants the
 * transport indirection could have broken.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendProviderDispatch } from '../dispatch';
import { mtaSendProvider } from '../mta';
import { providerFor } from '../index';
import { SEND_PROVIDER_CATALOG, sendProviderCatalogEntry } from '../catalog';
import { resolveRoute } from '../routing';
import { EmailErrorCode, type SendProviderKind, type SendProviderModule } from '../types';
import {
	_resetSendTransportCacheForTests,
	defaultSendTransportId,
	listSendTransports,
	resolveSendTransport,
} from '../transports';

type WritableRetryDelays = { retryDelays: readonly number[] };
function setRetryDelays(
	provider: SendProviderModule<SendProviderKind>,
	delays: readonly number[]
): void {
	(provider as unknown as WritableRetryDelays).retryDelays = delays;
}

interface ScheduledRecord {
	providerType: string;
	success: boolean;
	latencyMs: number;
}

function buildFakeCtx(): {
	ctx: Parameters<typeof sendProviderDispatch>[0];
	scheduled: ScheduledRecord[];
} {
	const scheduled: ScheduledRecord[] = [];
	const ctx = {
		runMutation: vi.fn(async () => true),
		scheduler: {
			runAfter: vi.fn(async (_ms: number, _ref: unknown, args: ScheduledRecord) => {
				scheduled.push(args);
			}),
		},
	};
	return { ctx: ctx as unknown as Parameters<typeof sendProviderDispatch>[0], scheduled };
}

const sampleParams = {
	to: 'to@example.com',
	from: 'from@example.com',
	subject: 'subject',
	html: '<p>hi</p>',
};

const originalFetch = global.fetch;

beforeEach(() => {
	_resetSendTransportCacheForTests();
});

afterEach(() => {
	vi.unstubAllEnvs();
	global.fetch = originalFetch;
	_resetSendTransportCacheForTests();
});

describe('single-transport deployment is unchanged', () => {
	it('exposes exactly one transport per catalog kind when no instances are declared', () => {
		const transports = listSendTransports();
		expect(transports.map((transport) => transport.id)).toEqual(
			SEND_PROVIDER_CATALOG.map((entry) => entry.kind)
		);
		for (const transport of transports) {
			expect(transport.id).toBe(transport.kind);
			expect(transport.instanceKey).toBeNull();
			expect(transport.label).toBe(sendProviderCatalogEntry(transport.kind).label);
			expect(transport.retryDelays).toEqual(sendProviderCatalogEntry(transport.kind).retryDelays);
			expect(transport.requiredEnvVars).toEqual(
				sendProviderCatalogEntry(transport.kind).requiredEnvVars
			);
		}
	});

	it('resolves the default instance even when the deployment is not configured', () => {
		vi.stubEnv('MTA_API_URL', '');
		vi.stubEnv('MTA_API_KEY', '');
		// A default instance is NEVER gated on configuration: an unconfigured
		// deployment must keep producing the adapter's own AUTH_FAILED, not a
		// resolution throw. Only NAMED instances fail closed on missing config.
		expect(() => resolveSendTransport(defaultSendTransportId('mta'))).not.toThrow();
	});

	it('keeps the adapter-level unconfigured outcome, message and attempt count', async () => {
		vi.stubEnv('MTA_API_URL', '');
		const { ctx, scheduled } = buildFakeCtx();

		const dispatched = await sendProviderDispatch(ctx, defaultSendTransportId('mta'), sampleParams);

		expect(dispatched.result.success).toBe(false);
		if (!dispatched.result.success) {
			expect(dispatched.result.errorCode).toBe(EmailErrorCode.AUTH_FAILED);
			// Unsuffixed: the default instance names the plain variable exactly as
			// the pre-refactor adapter did.
			expect(dispatched.result.errorMessage).toBe('MTA_API_URL environment variable is not set');
		}
		expect(dispatched.attempts).toBe(1);
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]!.providerType).toBe('mta');
	});

	it('records health keyed by provider KIND, as the providerHealth table expects', async () => {
		vi.stubEnv('MTA_API_URL', 'https://mta.test');
		vi.stubEnv('MTA_API_KEY', 'k');
		global.fetch = vi.fn().mockImplementation(
			async () =>
				new Response(JSON.stringify({ success: true, id: 'x' }), {
					status: 200,
				})
		) as unknown as typeof fetch;
		const { ctx, scheduled } = buildFakeCtx();

		const dispatched = await sendProviderDispatch(ctx, defaultSendTransportId('mta'), sampleParams);

		expect(dispatched.providerType).toBe('mta');
		expect(scheduled[0]!.providerType).toBe('mta');
		expect(scheduled[0]!.success).toBe(true);
	});

	it('keeps the retry loop driven by the adapter schedule and the error taxonomy', async () => {
		const originalDelays = mtaSendProvider.retryDelays;
		setRetryDelays(mtaSendProvider, [0, 0]);
		vi.stubEnv('MTA_API_URL', 'https://mta.test');
		vi.stubEnv('MTA_API_KEY', 'k');
		global.fetch = vi
			.fn()
			.mockImplementation(
				async () => new Response('server exploded', { status: 500 })
			) as unknown as typeof fetch;
		const { ctx } = buildFakeCtx();

		try {
			const dispatched = await sendProviderDispatch(
				ctx,
				defaultSendTransportId('mta'),
				sampleParams
			);
			expect(dispatched.attempts).toBe(3);
			expect(dispatched.result.success).toBe(false);
			if (!dispatched.result.success) {
				expect(dispatched.result.errorCode).toBe(EmailErrorCode.SERVER_ERROR);
			}
		} finally {
			setRetryDelays(mtaSendProvider, originalDelays);
		}
	});

	it('leaves the adapter registry and per-kind retry schedules untouched', () => {
		for (const entry of SEND_PROVIDER_CATALOG) {
			expect(providerFor(entry.kind).kind).toBe(entry.kind);
		}
		expect(providerFor('mta').retryDelays).toEqual([1000, 5000]);
		expect(providerFor('ses').retryDelays).toEqual([1000, 5000, 30000]);
		expect(providerFor('resend').retryDelays).toEqual([1000, 5000, 30000]);
		expect(providerFor('smtp').retryDelays).toEqual([1000, 5000, 30000]);
	});

	it('leaves route + strategy selection keyed by provider kind', () => {
		expect(
			resolveRoute({
				strategy: 'single',
				providers: [{ providerType: 'mta', isEnabled: true }],
			})
		).toEqual({ providerType: 'mta', source: 'org_config' });

		expect(
			resolveRoute({
				strategy: 'priority_failover',
				providers: [
					{ providerType: 'mta', isEnabled: true },
					{ providerType: 'ses', isEnabled: true },
				],
			})?.providerType
		).toBe('mta');

		vi.stubEnv('EMAIL_PROVIDER', 'resend');
		expect(resolveRoute(null)).toEqual({ providerType: 'resend', source: 'env_fallback' });
	});
});
