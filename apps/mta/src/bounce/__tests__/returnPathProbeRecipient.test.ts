import { describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import type { SmtpAddress, SmtpSession } from '@owlat/smtp-listener';
import { returnPathProbeRecipient } from '@owlat/shared/verp';
import { buildOnRcptTo, type RecipientGateTransaction } from '../recipientGate.js';
import type { MtaConfig } from '../../config.js';

/**
 * The reserved return-path probe recipient.
 *
 * A capability probe is addressed to `return-path-probe-<id>@<bounce domain>`
 * precisely so that it is REFUSED and the relay generates a DSN we can
 * attribute. Before this rule the refusal was incidental — it depended on no
 * mailbox and no route existing at that address — so an operator adding a
 * catch-all route or a mailbox at the bounce domain would swallow every probe:
 * no DSN, every probe ages out, and EVERY relay grades unsupported forever with
 * nothing to diagnose. The rule is therefore explicit and is checked BEFORE any
 * mailbox or route lookup.
 */

const RETURN_PATH_DOMAIN = 'bounces.example.com';

const config = {
	returnPathDomain: RETURN_PATH_DOMAIN,
	webhookSecret: 'x'.repeat(32),
	convexSiteUrl: 'https://example.convex.site',
} as unknown as MtaConfig;

/** A Redis that would ACCEPT anything — a catch-all mailbox and a catch-all route. */
function catchAllRedis(): { redis: Redis; calls: number } {
	const state = { calls: 0 };
	const redis = new Proxy(
		{},
		{
			get() {
				state.calls++;
				return vi.fn(async () => null);
			},
		}
	) as Redis;
	return {
		redis,
		get calls() {
			return state.calls;
		},
	};
}

function session(): SmtpSession<unknown, RecipientGateTransaction> {
	return { rcptTo: [] } as unknown as SmtpSession<unknown, RecipientGateTransaction>;
}

const address = (value: string): SmtpAddress => ({ address: value }) as SmtpAddress;

describe('return-path probe recipients are always refused', () => {
	it('550s a probe recipient at the bounce domain', async () => {
		const onRcptTo = buildOnRcptTo(config, catchAllRedis().redis);
		const result = await onRcptTo(
			address(returnPathProbeRecipient('probe-1', RETURN_PATH_DOMAIN)),
			session()
		);
		expect(result).toMatchObject({ code: 550 });
	});

	it('refuses BEFORE any mailbox or route lookup, so a catch-all cannot swallow it', async () => {
		const store = catchAllRedis();
		const onRcptTo = buildOnRcptTo(config, store.redis);
		await onRcptTo(address(returnPathProbeRecipient('probe-2', RETURN_PATH_DOMAIN)), session());
		expect(store.calls).toBe(0);
	});

	it('is case-insensitive on both halves of the address', async () => {
		const onRcptTo = buildOnRcptTo(config, catchAllRedis().redis);
		const result = await onRcptTo(
			address(`RETURN-PATH-PROBE-Probe3@${RETURN_PATH_DOMAIN.toUpperCase()}`),
			session()
		);
		expect(result).toMatchObject({ code: 550 });
	});

	it('does NOT claim the same local part at an unrelated domain', async () => {
		// The rule is scoped to OUR bounce domain: a lookalike local part at a
		// hosted mailbox domain must keep taking the normal mailbox path.
		const store = catchAllRedis();
		const onRcptTo = buildOnRcptTo(config, store.redis);
		await onRcptTo(address('return-path-probe-9@customer.example'), session());
		expect(store.calls).toBeGreaterThan(0);
	});

	it('leaves the shipped bounce/FBL recipients untouched', async () => {
		const store = catchAllRedis();
		const onRcptTo = buildOnRcptTo(config, store.redis);
		expect(await onRcptTo(address(`bounce+abc@${RETURN_PATH_DOMAIN}`), session())).toBeUndefined();
		expect(await onRcptTo(address(`fbl+abc@${RETURN_PATH_DOMAIN}`), session())).toBeUndefined();
		expect(store.calls).toBe(0);
	});
});
