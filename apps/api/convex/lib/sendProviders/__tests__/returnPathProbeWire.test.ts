/**
 * THE PROBE WIRE IS A PER-ADAPTER CAPABILITY (plan D5).
 *
 * A return-path verdict is written against ONE transport id, so the send that
 * produced it must have left through THAT transport's adapter. Before `mandrill`
 * became the second probe-decided kind the probe reached for the smtp module
 * unconditionally, which meant a Mandrill probe would have resolved
 * `SMTP_RELAY_*` and filed the answer under `transportId: 'mandrill'`.
 *
 * These are the structural halves of the fix: which modules offer a probe wire
 * at all, and what the one that does actually puts on the socket. The socket is
 * stubbed; nothing here touches a network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VERP_KEY_MIN_BYTES, parseVerpAddress } from '@owlat/shared/verp';

const sendMessage = vi.hoisted(() => vi.fn());

vi.mock('@owlat/smtp-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('@owlat/smtp-client')>()),
	sendMessage,
}));

import { SEND_PROVIDERS } from '../index';
import { isProbeDecidedReturnPathKind } from '../catalog';
import { _resetSmtpConfigCacheForTests } from '../smtp';
import type { SendTransportRecord } from '../transports';

const KEY = 'probe-wire-key-'.padEnd(VERP_KEY_MIN_BYTES, 'x');
const NOW = Date.UTC(2026, 7, 4, 9, 0, 0);

const SMTP_TRANSPORT = {
	id: 'smtp',
	kind: 'smtp',
	instanceKey: null,
	label: 'SMTP relay',
} as unknown as SendTransportRecord;

const PROBE_PARAMS = {
	to: 'probe+abc@bounces.example.com',
	from: 'news@example.com',
	subject: 'Owlat return-path capability probe',
	html: '<p>Automated return-path capability probe. No action is required.</p>',
	text: 'Automated return-path capability probe. No action is required.',
	headers: { 'X-Owlat-Return-Path-Probe': 'probe-1' },
};

describe('which adapters can carry a return-path probe', () => {
	it('the SMTP relay can: submission lets us choose the whole RFC5321.MailFrom', () => {
		expect(typeof SEND_PROVIDERS.smtp.sendReturnPathProbe).toBe('function');
	});

	it('Mandrill CANNOT, and declines rather than borrowing another wire', () => {
		// `return_path_domain` names a DOMAIN; Mandrill mints the local part, which
		// is exactly where the signed probe token lives. Implementing the wire by
		// mapping the probe onto it would put an address on the wire that no DSN
		// could be attributed to — and the verdict would still be filed under
		// `mandrill`.
		expect(SEND_PROVIDERS.mandrill.sendReturnPathProbe).toBeUndefined();
	});

	it.each(['mta', 'ses', 'resend'] as const)(
		'%s declares its answer, so it offers no probe wire either',
		(kind) => {
			expect(SEND_PROVIDERS[kind].sendReturnPathProbe).toBeUndefined();
		}
	);

	it('only a PROBE-DECIDED kind may implement the wire', () => {
		// The counterweight to the assertions above: a future adapter that adds a
		// probe wire to a kind whose catalog entry already declares `yes`/`no` would
		// be spending a deliberate hard bounce to re-learn a settled declaration.
		for (const [kind, module] of Object.entries(SEND_PROVIDERS)) {
			if (module.sendReturnPathProbe === undefined) continue;
			expect({ kind, probeDecided: isProbeDecidedReturnPathKind(module.kind) }).toEqual({
				kind,
				probeDecided: true,
			});
		}
	});
});

describe('the SMTP relay probe wire', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		sendMessage.mockReset();
		sendMessage.mockResolvedValue(undefined);
		_resetSmtpConfigCacheForTests();
		vi.stubEnv('SMTP_RELAY_HOST', 'relay.example.net');
		vi.stubEnv('SMTP_RELAY_USERNAME', 'relay-user');
		vi.stubEnv('SMTP_RELAY_PASSWORD', 'relay-pass');
		vi.stubEnv('MTA_BOUNCE_VERP_KEY', KEY);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it('puts the PROBE id — not the composed Message-ID — in the VERP token', async () => {
		const outcome = await SEND_PROVIDERS.smtp.sendReturnPathProbe!(SMTP_TRANSPORT, PROBE_PARAMS, {
			returnPathHost: 'bounces.example.com',
			verpMessageId: 'probe_probe-1',
		});

		// Indexed rather than `.at(-1)`: convex/tsconfig.json's lib stops at ES2021.
		const calls = sendMessage.mock.calls;
		const call = calls[calls.length - 1] as [{ envelope: { from: string } }] | undefined;
		if (!call) throw new Error('sendMessage was never called');
		expect(call[0].envelope.from).toBe(outcome.envelopeSender);
		expect(outcome.isVerp).toBe(true);
		// The DSN can only be attributed back to this probe because the id it
		// encodes is the probe's own — the entire evidence mechanism.
		expect(parseVerpAddress(outcome.envelopeSender, KEY, NOW)).toBe('probe_probe-1');
		expect(outcome.envelopeSender.endsWith('@bounces.example.com')).toBe(true);
		expect(outcome.attempt.success).toBe(true);
	});
});
