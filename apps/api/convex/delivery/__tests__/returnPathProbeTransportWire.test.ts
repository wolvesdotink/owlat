/**
 * A PROBE MAY ONLY EVER PRODUCE EVIDENCE ABOUT THE TRANSPORT IT RODE (plan D5).
 *
 * `runReturnPathProbe` gates on the catalog's `supportsCustomReturnPath: 'probe'`
 * declaration, and `mandrill` is the second kind to carry it. Until the wire
 * became per-adapter, the action's send step always called the SMTP module: a
 * Mandrill probe would have resolved `SMTP_RELAY_HOST/USERNAME/PASSWORD` off a
 * Mandrill transport record, put a message on somebody else's relay, and filed
 * the verdict under `transportId: 'mandrill'`. A false `supported` there is what
 * makes the send path stamp `return_path_domain` on real Mandrill mail.
 *
 * The three claims, in order: probing Mandrill touches NO smtp socket and NO
 * Mandrill HTTP call, it settles a verdict that says which question was actually
 * answered, and the row it writes names the transport the answer is about. The
 * SMTP case closes the loop — that transport still rides its own wire, and it is
 * the only one of the two that spends a bounce.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VERP_KEY_MIN_BYTES, parseVerpAddress } from '@owlat/shared/verp';

const sendMessage = vi.hoisted(() => vi.fn());

vi.mock('@owlat/smtp-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('@owlat/smtp-client')>()),
	sendMessage,
}));

import { internal } from '../../_generated/api';
import schema from '../../schema';
import { modules } from '../../__tests__/testModules';
import { _resetSmtpConfigCacheForTests } from '../../lib/sendProviders/smtp';
import { returnPathProbeMessageId } from '../messageIdRouting';
import {
	BOUNCE_TOLERANCE_MULTIPLIER_PROVIDER_FEEDBACK,
	resolveReturnPathCapability,
} from '../../lib/sendProviders/returnPathCapability';

const KEY = 'probe-isolation-key-'.padEnd(VERP_KEY_MIN_BYTES, 'x');
const NOW = Date.UTC(2026, 7, 4, 10, 0, 0);

/** Every relay credential a borrowed wire would have picked up. */
function stubRelayCredentials(): void {
	vi.stubEnv('SMTP_RELAY_HOST', 'relay.example.net');
	vi.stubEnv('SMTP_RELAY_USERNAME', 'relay-user');
	vi.stubEnv('SMTP_RELAY_PASSWORD', 'relay-pass');
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	sendMessage.mockReset();
	sendMessage.mockResolvedValue(undefined);
	_resetSmtpConfigCacheForTests();
	// Mandrill's adapter is an HTTP one; a probe that reached it would show up
	// here. Rejecting rather than resolving makes an accidental call loud.
	fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests'));
	vi.stubEnv('MTA_RETURN_PATH_DOMAIN', 'bounces.example.com');
	vi.stubEnv('MTA_BOUNCE_VERP_KEY', KEY);
	vi.stubEnv('DEFAULT_FROM_EMAIL', 'news@example.com');
});

afterEach(() => {
	fetchSpy.mockRestore();
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

async function probeRows(t: ReturnType<typeof convexTest>) {
	return await t.run(async (ctx) => await ctx.db.query('sendTransportReturnPathProbes').collect());
}

describe('probing a mandrill transport', () => {
	beforeEach(() => {
		vi.stubEnv('MANDRILL_API_KEY', 'md-test-key');
		// Present and valid — the point is that they are never READ, not that they
		// are missing. A borrowed wire would connect happily with these.
		stubRelayCredentials();
	});

	it('never touches the smtp module and never calls Mandrill', async () => {
		const t = convexTest(schema, modules);

		const result = await t.action(internal.delivery.relayReturnPathProbe.runReturnPathProbe, {
			transportId: 'mandrill',
			force: true,
		});

		expect(result).toEqual({ ran: false, reason: 'no_envelope_control' });
		expect(sendMessage).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('files the verdict under the transport it is about, with no send behind it', async () => {
		const t = convexTest(schema, modules);
		await t.action(internal.delivery.relayReturnPathProbe.runReturnPathProbe, {
			transportId: 'mandrill',
			force: true,
		});

		const rows = await probeRows(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			transportId: 'mandrill',
			status: 'unsupported',
			// NOT `rejected_by_relay` (no relay ruled on anything) and NOT
			// `no_bounce_observed` (nothing was sent to hear back from).
			reason: 'no_envelope_control',
			// Nothing reached a wire, so there is no address to claim we sent from.
			sentEnvelopeSender: '',
			settledAt: NOW,
		});
	});

	it('resolves to unsupported + the provider-feedback tolerance, never an error', async () => {
		const t = convexTest(schema, modules);
		await t.action(internal.delivery.relayReturnPathProbe.runReturnPathProbe, {
			transportId: 'mandrill',
			force: true,
		});
		const rows = await probeRows(t);

		const resolved = resolveReturnPathCapability(
			'mandrill',
			{
				status: rows[0]!.status,
				reason: rows[0]!.reason,
				sentEnvelopeSender: rows[0]!.sentEnvelopeSender,
				startedAt: rows[0]!.startedAt,
				settledAt: rows[0]!.settledAt,
			},
			NOW
		);
		expect(resolved.capability).toBe('unsupported');
		// Mandrill reports bounces over its own webhooks, so the arm is coarser —
		// not blind. D2: a widened tolerance, never a block.
		expect(resolved.bounceToleranceMultiplier).toBe(BOUNCE_TOLERANCE_MULTIPLIER_PROVIDER_FEEDBACK);
	});

	it('re-settles on the SCHEDULE, not on every sweep', async () => {
		// Mandrill alone this time, so the assertions are about it and not about
		// the relay the sweep would otherwise probe alongside it.
		vi.stubEnv('SMTP_RELAY_HOST', '');
		vi.stubEnv('SMTP_RELAY_USERNAME', '');
		vi.stubEnv('SMTP_RELAY_PASSWORD', '');
		const t = convexTest(schema, modules);
		// The sweep runs hourly. A verdict rewritten every tick would reset
		// `settledAt`, inflate `attempts`, and make a 24h→7d→30d backoff meaningless.
		// It also costs the per-tick probe budget nothing: no bounce was
		// manufactured, so `probed` stays 0.
		expect(
			await t.action(internal.delivery.relayReturnPathProbe.sweepReturnPathProbes, {})
		).toEqual({ expired: 0, probed: 0 });
		expect(
			await t.action(internal.delivery.relayReturnPathProbe.sweepReturnPathProbes, {})
		).toEqual({ expired: 0, probed: 0 });

		const rows = await probeRows(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ attempts: 1, reason: 'no_envelope_control', settledAt: NOW });
	});
});

describe('probing the smtp transport', () => {
	beforeEach(() => {
		stubRelayCredentials();
	});

	it('still rides its OWN wire and records the address it put on it', async () => {
		const t = convexTest(schema, modules);

		const result = await t.action(internal.delivery.relayReturnPathProbe.runReturnPathProbe, {
			transportId: 'smtp',
			force: true,
		});

		expect(result).toMatchObject({ ran: true, accepted: true });
		expect(sendMessage).toHaveBeenCalledTimes(1);

		const rows = await probeRows(t);
		expect(rows).toHaveLength(1);
		const row = rows[0]!;
		expect(row.transportId).toBe('smtp');
		// Acceptance is not a verdict — the probe stays open until a DSN arrives.
		expect(row.status).toBe('awaiting_delivery');
		// The recorded address is the one the socket saw, and its signed token
		// encodes THIS probe's id, which is what makes the eventual DSN attributable.
		const call = sendMessage.mock.calls[0] as [{ envelope: { from: string } }] | undefined;
		if (!call) throw new Error('sendMessage was never called');
		expect(row.sentEnvelopeSender).toBe(call[0].envelope.from);
		expect(parseVerpAddress(row.sentEnvelopeSender, KEY, NOW)).toBe(
			returnPathProbeMessageId(row.probeId)
		);
	});
});
