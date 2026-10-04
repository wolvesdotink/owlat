/**
 * A REDACTED COMPLAINT BLOCKS AN ADDRESS ONLY ON PROOF THIS DEPLOYMENT SENT
 * THE MAIL (#1227).
 *
 * RFC 5965 §3.2 lets an FBL redact the original Message-ID (Gmail does), so the
 * only thing a complaint carries is the address. There is no send to
 * transition; the dispatcher either blocklists the address directly or counts
 * the complaint, and the decision rests on whether the event proves THIS
 * deployment sent the mail.
 *
 * The shipped rule blocked on sight for every source that does not tag its
 * feedback (SES, Mandrill, Resend, SMTP, plugins). Their webhook signature
 * proves the provider sent the report, not which deployment sent the mail, so a
 * provider account or SNS topic shared between deployments let one deployment's
 * complaint silently stop mail to the address in another. The unknown-id branch
 * (#1194) already required attribution; this branch now applies the same rule:
 *   - the own MTA's `production` tag, written only on a report whose signed
 *     VERP token decoded, still blocklists the address;
 *   - everything else is counted in `unresolvedFeedback` as `unattributed`,
 *     with no address in the call, and blocks no one.
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
const RECORD = ref(internal.webhooks.unresolvedFeedback.record);
const ADDRESS = 'victim@example.com';

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

/** The one call an unattributed redacted complaint makes: a count, no address. */
function expectCountedNotBlocked(
	calls: { ref: string; args: unknown }[],
	extra: Record<string, unknown> = {}
): void {
	expect(calls).toEqual([
		{
			ref: RECORD,
			args: { kind: 'complaint', suppression: 'unattributed', at: 4000, ...extra },
		},
	]);
	expect(JSON.stringify(calls)).not.toContain('example.com');
}

describe('a recipient-only complaint from a source that does NOT tag its feedback', () => {
	it.each(['ses', 'mandrill', 'resend', 'smtp'] as const)(
		'counts the complaint reported by %s and blocks no one',
		async (providerType) => {
			// A shared account or SNS topic delivers another deployment's complaint
			// here with a genuine signature; nothing in it says who sent the mail.
			const calls = await dispatch({ recipient: ADDRESS, providerType });
			expectCountedNotBlocked(calls, { providerType });
		}
	);

	it('is not attributed by a tag the source does not write', async () => {
		// The tag is only evidence from the source that stamps it. On a relay's
		// event it says nothing, whichever value it carries.
		for (const deliveryDomain of ['production', 'member_test'] as const) {
			const calls = await dispatch({
				recipient: ADDRESS,
				providerType: 'mandrill',
				deliveryDomain,
			});
			expectCountedNotBlocked(calls, { providerType: 'mandrill', deliveryDomain });
		}
	});
});

describe('a recipient-only complaint from a source that DOES tag its feedback', () => {
	it('blocklists on a production tag and stores nothing', async () => {
		const calls = await dispatch({
			recipient: ADDRESS,
			providerType: 'mta',
			deliveryDomain: 'production',
		});
		expect(calls).toEqual([{ ref: BLOCKLIST, args: { email: ADDRESS, reason: 'complained' } }]);
	});

	it.each([
		{ label: 'member preview', deliveryDomain: 'member_test' as const },
		{ label: 'unknown provenance', deliveryDomain: undefined },
	])('counts a $label complaint from our own MTA without blocking', async ({ deliveryDomain }) => {
		const calls = await dispatch({
			recipient: ADDRESS,
			providerType: 'mta',
			...(deliveryDomain ? { deliveryDomain } : {}),
		});
		expectCountedNotBlocked(calls, {
			providerType: 'mta',
			...(deliveryDomain ? { deliveryDomain } : {}),
		});
	});
});

describe('a recipient-only complaint whose SOURCE cannot be identified', () => {
	it.each([
		{ label: 'no providerType at all', providerType: undefined },
		{ label: 'a kind this deployment does not have', providerType: 'plugin.acme.postmark' },
	])('blocks no one for $label, even with a production tag', async ({ providerType }) => {
		// Blocklisting on an unattributable report is the one error here that is
		// invisible and permanent: the recipient simply stops receiving mail.
		for (const deliveryDomain of [undefined, 'production' as const]) {
			const calls = await dispatch({
				recipient: ADDRESS,
				...(providerType ? { providerType } : {}),
				...(deliveryDomain ? { deliveryDomain } : {}),
			});
			expectCountedNotBlocked(calls, {
				...(providerType ? { providerType } : {}),
				...(deliveryDomain ? { deliveryDomain } : {}),
			});
		}
	});
});

describe('a complaint that names neither a message nor a recipient', () => {
	it('does nothing', async () => {
		expect(await dispatch({ providerType: 'ses' })).toEqual([]);
	});
});
