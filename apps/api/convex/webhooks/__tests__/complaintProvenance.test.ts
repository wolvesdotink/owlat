/**
 * A REDACTED COMPLAINT IS SUPPRESSED ON A CAPABILITY, NOT ON A PROVIDER NAME
 * (the seams plan's P0.4).
 *
 * RFC 5965 §3.2 lets an FBL redact the original Message-ID (Gmail does), so the
 * only thing a complaint carries is the address. There is no send to
 * transition; the dispatcher blocklists the address directly, and the whole
 * decision rests on whether the report is about real production mail.
 *
 * The shipped gate was `e.providerType === 'ses' || e.deliveryDomain ===
 * 'production'` — SES BY NAME, for a property SES shares with every third-party
 * ESP: nobody annotates their webhook with our `deliveryDomain`, because that
 * tag is written by `applyFeedbackProvenancePolicy` on the way out of our own
 * infrastructure and nowhere else. So a byte-identical redacted complaint
 * arriving from Mandrill, an SMTP relay's FBL or a plugin ESP was DROPPED and
 * the complainer stayed mailable, which is the one thing a feedback loop exists
 * to prevent.
 *
 * DIFFERENTIAL, all three directions:
 *   - the SES cases pin the shipped behaviour byte for byte;
 *   - the Mandrill/Resend/SMTP cases are unsatisfiable by an `=== 'ses'` gate;
 *   - the own-MTA and unidentifiable-source cases pin that the tag is still
 *     REQUIRED where it exists, so member-preview mail and unattributed reports
 *     do not blocklist a recipient — an error that is invisible and permanent.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../_generated/api', () => {
	const makeRef = (path: string): unknown =>
		new Proxy(
			{},
			{
				get(_t, prop: string | symbol) {
					if (typeof prop === 'symbol') return undefined;
					if (prop === 'toString') return () => path;
					return makeRef(`${path}.${prop}`);
				},
			}
		);
	return { internal: makeRef('internal'), api: makeRef('api') };
});

import { internal } from '../../_generated/api';
import { dispatchInboundEvent } from '../dispatcher';
import type { InboundEvent } from '../types';
import type { ActionCtx } from '../../_generated/server';

const ref = (r: unknown): string => `${r as string}`;
const BLOCKLIST = ref(internal.blockedEmails.addFromEvent);

function makeCtx() {
	const runMutationCalls: { ref: string; args: unknown }[] = [];
	const ctx = {
		runMutation: vi.fn(async (r: unknown, args: unknown) => {
			runMutationCalls.push({ ref: ref(r), args });
			return undefined;
		}),
		scheduler: { runAfter: vi.fn(async () => undefined) },
	} as unknown as ActionCtx;
	return { ctx, runMutationCalls };
}

beforeEach(() => {
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

async function dispatch(
	event: Omit<Extract<InboundEvent, { kind: 'email.complained' }>, 'kind' | 'at'>
): Promise<{ ref: string; args: unknown }[]> {
	const { ctx, runMutationCalls } = makeCtx();
	await dispatchInboundEvent(ctx, { kind: 'email.complained', at: 4000, ...event } as InboundEvent);
	return runMutationCalls;
}

describe('a recipient-only complaint from a source that does NOT tag its feedback', () => {
	it.each(['ses', 'mandrill', 'resend', 'smtp'] as const)(
		'blocklists the address reported by %s, with no provenance tag to show',
		async (providerType) => {
			const calls = await dispatch({ recipient: 'victim@example.com', providerType });
			expect(calls).toEqual([
				{ ref: BLOCKLIST, args: { email: 'victim@example.com', reason: 'complained' } },
			]);
		}
	);

	it('does not require the tag it could never carry, even alongside one', async () => {
		// A relay-sourced event that somehow arrived with a member-preview tag is
		// still suppressed: the tag is not the relay's to set, so it is not evidence
		// about the relay's report.
		const calls = await dispatch({
			recipient: 'victim@example.com',
			providerType: 'mandrill',
			deliveryDomain: 'member_test',
		});
		expect(calls).toHaveLength(1);
	});
});

describe('a recipient-only complaint from a source that DOES tag its feedback', () => {
	it('blocklists on a production tag', async () => {
		const calls = await dispatch({
			recipient: 'victim@example.com',
			providerType: 'mta',
			deliveryDomain: 'production',
		});
		expect(calls).toEqual([
			{ ref: BLOCKLIST, args: { email: 'victim@example.com', reason: 'complained' } },
		]);
	});

	it.each([
		{ label: 'member preview', deliveryDomain: 'member_test' as const },
		{ label: 'unknown provenance', deliveryDomain: undefined },
	])('drops a $label complaint from our own MTA', async ({ deliveryDomain }) => {
		expect(
			await dispatch({
				recipient: 'victim@example.com',
				providerType: 'mta',
				...(deliveryDomain ? { deliveryDomain } : {}),
			})
		).toEqual([]);
	});
});

describe('a recipient-only complaint whose SOURCE cannot be identified', () => {
	it.each([
		{ label: 'no providerType at all', providerType: undefined },
		{ label: 'a kind this deployment does not have', providerType: 'plugin.acme.postmark' },
	])('requires the provenance tag for $label', async ({ providerType }) => {
		// Blocklisting on an unattributable report is the one error here that is
		// invisible and permanent — the recipient simply stops receiving mail — so
		// an event carrying no evidence about who observed it must show the tag.
		expect(
			await dispatch({
				recipient: 'victim@example.com',
				...(providerType ? { providerType } : {}),
			})
		).toEqual([]);
		expect(
			await dispatch({
				recipient: 'victim@example.com',
				deliveryDomain: 'production',
				...(providerType ? { providerType } : {}),
			})
		).toHaveLength(1);
	});
});
