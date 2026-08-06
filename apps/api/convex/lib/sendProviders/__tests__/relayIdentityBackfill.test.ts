/**
 * THE BACKFILL PAIR'S FAILURE CONTRACT (the seams plan's P0.4).
 *
 * `ensureRelayIdentities` swallows every adapter throw, and it has to: the
 * forward caller runs inside the mutation that lands a domain's → verified
 * transition, so a propagating throw would roll that transition back and the
 * operator would see Verify error out with the domain stuck.
 *
 * BUT THE DRAIN USED TO GET ITS SIGNAL FROM EXACTLY THAT THROW. Before the pair
 * shared one implementation, `provisionDeliverabilityRelayBatch` awaited the
 * adapter directly, so a failure failed the scheduled mutation and surfaced in
 * Convex's scheduled-function failures. Swallowing it for the forward path's
 * sake takes that away from the drain too — and a page in which every domain
 * threw would then commit as a success, schedule its successor, and report the
 * drain complete having provisioned nothing, with the only later symptom the
 * relay refusing those From domains once the breaker opens.
 *
 * So the outcome is RETURNED, per kind, and these cases pin the two facts the
 * drain's summary is built from: which kinds failed, and that the loop kept
 * going past the one that did.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Doc } from '../../../_generated/dataModel';
import type { MutationCtx } from '../../../_generated/server';
import { ensureRelayIdentities, type RelayIdentityBackfill } from '../fallbackRelays';
import { OWN_SENDING_DOMAIN_PROVIDER_KIND } from '../../../domains/providers';

const ctx = {} as MutationCtx;

function ownDomain(providerType: string = OWN_SENDING_DOMAIN_PROVIDER_KIND): Doc<'domains'> {
	return {
		_id: 'domain-1',
		domain: 'sender.example.com',
		providerType,
	} as unknown as Doc<'domains'>;
}

/** A backfill bound to `kind`, succeeding or throwing as asked. */
function backfill(kind: string, throws = false): RelayIdentityBackfill {
	return {
		kind: kind as RelayIdentityBackfill['kind'],
		ensureRelayIdentity: vi.fn(async () => {
			if (throws) throw new Error(`${kind} lookup failed`);
		}),
	};
}

describe('ensureRelayIdentities reports what it swallowed', () => {
	it('names the kind that threw and keeps going', async () => {
		// A ONE-KIND FAILURE MUST NOT COST THE OTHER. The loop exists because a
		// deployment can configure two relays, and the shipped rule is that one bad
		// kind does not cost the whole page.
		const good = backfill('mandrill');
		const bad = backfill('ses', true);
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

		const outcome = await ensureRelayIdentities(ctx, ownDomain(), [bad, good]);

		expect(outcome).toEqual({ attempted: 2, failedKinds: ['ses'] });
		expect(good.ensureRelayIdentity).toHaveBeenCalledTimes(1);
		// The log line names the relay, not just the domain: with two configured,
		// an operator holding it has to know which one to re-provision.
		expect(logged.mock.calls.map(([message]) => String(message))).toContainEqual(
			expect.stringContaining('ses backfill failed for sender.example.com')
		);
		logged.mockRestore();
	});

	it('reports a wholly failed page rather than an empty success', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

		const outcome = await ensureRelayIdentities(ctx, ownDomain(), [
			backfill('ses', true),
			backfill('mandrill', true),
		]);

		expect(outcome).toEqual({ attempted: 2, failedKinds: ['ses', 'mandrill'] });
		logged.mockRestore();
	});

	it('never throws, so the caller’s transaction survives', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(
			ensureRelayIdentities(ctx, ownDomain(), [backfill('ses', true)])
		).resolves.toBeDefined();
		logged.mockRestore();
	});

	it('attempts nothing on a domain hosted at a provider of its own', async () => {
		// D3's sanctioned own-vs-not-own gate, and the outcome has to say so: a
		// drain page of relay-primary domains attempted zero backfills, which is
		// not the same fact as zero failures out of many.
		const only = backfill('ses');

		expect(await ensureRelayIdentities(ctx, ownDomain('ses'), [only])).toEqual({
			attempted: 0,
			failedKinds: [],
		});
		expect(only.ensureRelayIdentity).not.toHaveBeenCalled();
	});
});
