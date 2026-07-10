/**
 * Integration tests for natural-language handling rules: a compiled rule is
 * persisted, matches its senders and applies its action via the deterministic
 * `evaluateForMessage` query, a never-auto-send rule downgrades matching mail to
 * human review, a rule can never widen auto-send, and rules are revocable.
 *
 * The COMPILE call (mail/handlingRulesCompile.compile) is NOT exercised here —
 * we feed the already-compiled `{ matcher, action }` straight into `create`,
 * mocking the LLM step by supplying its structured output. The compile prompt is
 * covered by handlingRulesCompile.test.ts.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import { enableFeatures } from '../../__tests__/factories';
import { restrictAutonomy } from '../handlingRules/engine';
import type { Id } from '../../_generated/dataModel';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

// See workspaces/__tests__/settings.test.ts: re-prefix Vite's canonicalized
// sibling glob keys so convex-test's lookup prefix matches.
const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).map(([key, val]) => {
		if (key.startsWith('../') && !key.startsWith('../../')) {
			return ['../../mail/' + key.slice(3), val];
		}
		return [key, val];
	})
);

const asUser = { subject: 'test-user', issuer: 'test', tokenIdentifier: 'test|test-user' };

async function insertMessage(
	t: ReturnType<typeof convexTest>,
	over: Record<string, unknown> = {}
): Promise<Id<'inboundMessages'>> {
	return await t.run(async (ctx) => {
		return await ctx.db.insert('inboundMessages', {
			messageId: '<m1@example.com>',
			from: 'Recruiter <hi@recruit.io>',
			to: 'me@owlat.test',
			subject: 'Exciting opportunity',
			textBody: 'We have a great role for you.',
			processingStatus: 'classifying',
			receivedAt: Date.now(),
			...over,
		});
	});
}

describe('handlingRules CRUD + evaluation', () => {
	it('persists a compiled rule and lists it', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);

		const ruleId = await t.withIdentity(asUser).mutation(api.mail.handlingRules.create, {
			instruction: 'always decline recruiters',
			matcher: { senders: ['recruit.io'] },
			action: { type: 'draft_with_stance', stance: 'a polite decline' },
		});
		expect(ruleId).toBeDefined();

		const rules = await t.query(api.mail.handlingRules.list, {});
		expect(rules).toHaveLength(1);
		expect(rules[0]?.instruction).toBe('always decline recruiters');
		expect(rules[0]?.action.type).toBe('draft_with_stance');
	});

	it('a compiled rule matches its senders and applies the action', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);
		await t.withIdentity(asUser).mutation(api.mail.handlingRules.create, {
			instruction: 'file mail from acme as sales',
			matcher: { senders: ['acme.com'] },
			action: { type: 'categorize', category: 'sales' },
		});

		const matching = await insertMessage(t, { from: 'Jane <jane@acme.com>' });
		const out = await t.query(internal.mail.handlingRules.evaluateForMessage, {
			inboundMessageId: matching,
		});
		expect(out.categoryOverride).toBe('sales');

		const nonMatching = await insertMessage(t, { from: 'Bob <bob@other.com>' });
		const out2 = await t.query(internal.mail.handlingRules.evaluateForMessage, {
			inboundMessageId: nonMatching,
		});
		expect(out2.categoryOverride).toBeUndefined();
	});

	it('a never-auto-send rule downgrades matching mail to human review', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);
		await t.withIdentity(asUser).mutation(api.mail.handlingRules.create, {
			instruction: 'never auto-send to legal',
			matcher: { senders: ['legal.example'] },
			action: { type: 'never_auto_send' },
		});

		const msg = await insertMessage(t, { from: 'Counsel <counsel@legal.example>' });
		const out = await t.query(internal.mail.handlingRules.evaluateForMessage, {
			inboundMessageId: msg,
		});
		expect(out.restrictsAutoSend).toBe(true);

		// The route step folds this into its RESTRICT-only gate: a permitted
		// auto-send is downgraded to human review.
		expect(restrictAutonomy(true, out).allowed).toBe(false);
	});

	it('a rule cannot widen auto-send', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);
		// A permissive-sounding rule still only ever RESTRICTS: a denied base
		// decision stays denied regardless of the rule.
		await t.withIdentity(asUser).mutation(api.mail.handlingRules.create, {
			instruction: 'draft replies to acme',
			matcher: { senders: ['acme.com'] },
			action: { type: 'draft_with_stance', stance: 'warmly' },
		});
		const msg = await insertMessage(t, { from: 'Jane <jane@acme.com>' });
		const out = await t.query(internal.mail.handlingRules.evaluateForMessage, {
			inboundMessageId: msg,
		});
		expect(restrictAutonomy(false, out).allowed).toBe(false);
	});

	it('rules are revocable', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);
		const ruleId = await t.withIdentity(asUser).mutation(api.mail.handlingRules.create, {
			instruction: 'never auto-send to legal',
			matcher: { senders: ['legal.example'] },
			action: { type: 'never_auto_send' },
		});

		const msg = await insertMessage(t, { from: 'Counsel <counsel@legal.example>' });
		const before = await t.query(internal.mail.handlingRules.evaluateForMessage, {
			inboundMessageId: msg,
		});
		expect(before.restrictsAutoSend).toBe(true);

		await t.withIdentity(asUser).mutation(api.mail.handlingRules.remove, { ruleId });

		expect(await t.query(api.mail.handlingRules.list, {})).toHaveLength(0);
		const after = await t.query(internal.mail.handlingRules.evaluateForMessage, {
			inboundMessageId: msg,
		});
		expect(after.restrictsAutoSend).toBe(false);
	});

	it('rejects a rule with an empty matcher', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);
		await expect(
			t.withIdentity(asUser).mutation(api.mail.handlingRules.create, {
				instruction: 'do something',
				matcher: {},
				action: { type: 'never_auto_send' },
			})
		).rejects.toThrow();
	});
});
