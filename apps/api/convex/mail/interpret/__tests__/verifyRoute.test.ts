/**
 * Claim checks as decision questions (ADR-0073, plan Phase 3): which path
 * verifies an interpretation's claims under `claimVerification`. The language
 * verifier and the decisions lane's runner are mocked; the runner's own claim
 * and admission are tested in `decision/__tests__/phase3Bundles.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	verifyClaims: vi.fn(),
	runBundle: vi.fn(),
	resolveBundleRung: vi.fn(),
}));

vi.mock('../verify', () => ({ verifyClaims: mocks.verifyClaims }));
vi.mock('../../../decision/bundleRunner', () => ({
	runBundle: mocks.runBundle,
	resolveBundleRung: mocks.resolveBundleRung,
}));

import { verifyRouted } from '../verifyRoute';
import type { VerifyClaim } from '../pipeline';
import type { Id } from '../../../_generated/dataModel';

const claim = (id: string, statement = `Claim ${id}`): VerifyClaim => ({
	id,
	statement,
	quotes: [`quote of ${id}`],
});
const CLAIMS = [claim('item:0'), claim('item:1'), claim('transition:0')];

const source = { kind: 'inbound' as const, id: 'in_1' as Id<'inboundMessages'> };
const root = { rootRequestId: 'team:in_1' };

function ctxWith(policy: Record<string, unknown>) {
	return {
		runQuery: vi.fn(async () => ({
			policy: {
				claimVerification: 'off',
				verifyClaimCapPerMessage: null,
				policyVersion: 2,
				...policy,
			},
			isDecisionPlaneOn: true,
		})),
	} as never;
}

const rung = (value: 'decision' | 'language' | 'unavailable') => ({ rung: value, plane: null });

beforeEach(() => {
	mocks.verifyClaims.mockReset();
	mocks.runBundle.mockReset();
	mocks.resolveBundleRung.mockReset();
	mocks.verifyClaims.mockImplementation(async (_ctx: unknown, claims: VerifyClaim[]) => ({
		verdicts: new Map(claims.map((c) => [c.id, 'supported'])),
		isIncomplete: false,
	}));
});

describe('claim verification off (the default)', () => {
	it('sends every claim to the language verifier and asks no decision', async () => {
		const out = await verifyRouted(ctxWith({}), CLAIMS, { source, root });
		expect(mocks.verifyClaims).toHaveBeenCalledWith(expect.anything(), CLAIMS, root);
		expect(mocks.resolveBundleRung).not.toHaveBeenCalled();
		expect(mocks.runBundle).not.toHaveBeenCalled();
		expect(out).toMatchObject({ isIncomplete: false, isCapped: false, isUnavailable: false });
		expect(out.verdicts.size).toBe(3);
	});

	it('reads nothing when there is nothing to verify', async () => {
		const ctx = ctxWith({});
		await verifyRouted(ctx, [], { source, root });
		expect(
			(ctx as unknown as { runQuery: ReturnType<typeof vi.fn> }).runQuery
		).not.toHaveBeenCalled();
		expect(mocks.verifyClaims).not.toHaveBeenCalled();
	});
});

describe('claim checks enforced', () => {
	it('asks one decision question per claim on the decision rung, and no language verifier', async () => {
		mocks.resolveBundleRung.mockResolvedValue(rung('decision'));
		mocks.runBundle
			.mockResolvedValueOnce({ hasRun: true, status: 'complete', labels: { verdict: 'supported' } })
			.mockResolvedValueOnce({
				hasRun: true,
				status: 'complete',
				labels: { verdict: 'contradicted' },
			})
			.mockResolvedValueOnce({ hasRun: false, why: 'settled', labels: { verdict: 'unknown' } });
		const out = await verifyRouted(ctxWith({ claimVerification: 'enforce' }), CLAIMS, {
			source,
			root,
		});
		expect(mocks.verifyClaims).not.toHaveBeenCalled();
		expect(mocks.runBundle).toHaveBeenCalledTimes(3);
		expect(mocks.runBundle.mock.calls[0]![1]).toMatchObject({
			bundle: { id: 'mail.claim_check' },
			plan: { task: 'mail.claim_check', mode: 'advisory' },
			subject: { kind: 'inbound_message', inboundMessageId: 'in_1' },
			built: { state: { claim: 'Claim item:0', quotes: ['quote of item:0'] } },
			resolved: rung('decision'),
			root,
		});
		expect([...out.verdicts]).toEqual([
			['item:0', 'supported'],
			['item:1', 'unsupported'],
			['transition:0', 'unclear'],
		]);
		expect(out).toMatchObject({ isIncomplete: false, isUnsendable: false });
	});

	it('leaves a claim without an answer unverified, and the run retries', async () => {
		mocks.resolveBundleRung.mockResolvedValue(rung('decision'));
		mocks.runBundle.mockResolvedValue({ hasRun: false, why: 'admission_unavailable' });
		const out = await verifyRouted(ctxWith({ claimVerification: 'enforce' }), CLAIMS, {
			source,
			root,
		});
		expect(out.verdicts.size).toBe(0);
		expect(out.isIncomplete).toBe(true);
		expect(mocks.verifyClaims).not.toHaveBeenCalled();
	});

	it('never sends a clipped claim: it stays unverified as unsendable', async () => {
		mocks.resolveBundleRung.mockResolvedValue(rung('decision'));
		mocks.runBundle.mockResolvedValue({
			hasRun: true,
			status: 'complete',
			labels: { verdict: 'supported' },
		});
		const long = claim('item:9', 'x'.repeat(5_000));
		const out = await verifyRouted(ctxWith({ claimVerification: 'enforce' }), [long], {
			source,
			root,
		});
		expect(mocks.runBundle).not.toHaveBeenCalled();
		expect(out).toMatchObject({ isUnsendable: true, isIncomplete: false });
		expect(out.verdicts.size).toBe(0);
	});

	it('keeps the language verifier on the language rung (it IS that rung)', async () => {
		mocks.resolveBundleRung.mockResolvedValue(rung('language'));
		const out = await verifyRouted(ctxWith({ claimVerification: 'enforce' }), CLAIMS, {
			source,
			root,
		});
		expect(mocks.verifyClaims).toHaveBeenCalledTimes(1);
		expect(mocks.runBundle).not.toHaveBeenCalled();
		expect(out.verdicts.size).toBe(3);
	});

	it('verifies nothing, with no language call, when the provider cannot answer (D3)', async () => {
		mocks.resolveBundleRung.mockResolvedValue(rung('unavailable'));
		const out = await verifyRouted(ctxWith({ claimVerification: 'enforce' }), CLAIMS, {
			source,
			root,
		});
		expect(mocks.verifyClaims).not.toHaveBeenCalled();
		expect(mocks.runBundle).not.toHaveBeenCalled();
		expect(out).toMatchObject({ isUnavailable: true, isIncomplete: false });
		expect(out.verdicts.size).toBe(0);
	});

	it.each([
		['moved', async () => 'stale'],
		['threw', async () => Promise.reject(new Error('decrypt failed'))],
	])('retries later, with no language call, when the configuration %s', async (_, resolve) => {
		mocks.resolveBundleRung.mockImplementation(resolve);
		const out = await verifyRouted(ctxWith({ claimVerification: 'enforce' }), CLAIMS, {
			source,
			root,
		});
		expect(mocks.verifyClaims).not.toHaveBeenCalled();
		expect(out).toMatchObject({ isIncomplete: true, isUnavailable: false });
	});

	it('uses the language verifier for a Team reply, which no artifact can be about', async () => {
		const out = await verifyRouted(ctxWith({ claimVerification: 'enforce' }), CLAIMS, {
			source: { kind: 'teamReply', id: 'ts_1' as Id<'transactionalSends'> },
			root,
		});
		expect(mocks.resolveBundleRung).not.toHaveBeenCalled();
		expect(mocks.verifyClaims).toHaveBeenCalledTimes(1);
		expect(out.verdicts.size).toBe(3);
	});
});

describe('claim checks in shadow', () => {
	it('lets the verifier decide and asks each verified claim beside it', async () => {
		mocks.resolveBundleRung.mockResolvedValue(rung('decision'));
		mocks.runBundle.mockResolvedValue({ hasRun: false, why: 'not_sampled' });
		mocks.verifyClaims.mockResolvedValue({
			verdicts: new Map([
				['item:0', 'supported'],
				['item:1', 'unclear'],
			]),
			isIncomplete: true,
		});
		const out = await verifyRouted(ctxWith({ claimVerification: 'shadow' }), CLAIMS, {
			source: {
				kind: 'mail',
				id: 'm_1' as Id<'mailMessages'>,
			},
			mailboxId: 'mbx_1' as Id<'mailboxes'>,
			root,
		});
		expect([...out.verdicts]).toEqual([
			['item:0', 'supported'],
			['item:1', 'unclear'],
		]);
		expect(out.isIncomplete).toBe(true);
		expect(mocks.runBundle.mock.calls.map((call) => call[1].baseline)).toEqual([
			{ verdict: 'supported' },
			{ verdict: 'insufficient' },
		]);
		expect(mocks.runBundle.mock.calls[0]![1]).toMatchObject({
			plan: { mode: 'shadow' },
			subject: { kind: 'mail_message', mailMessageId: 'm_1', mailboxId: 'mbx_1' },
		});
	});

	it('asks no shadow off the decision rung', async () => {
		mocks.resolveBundleRung.mockResolvedValue(rung('language'));
		await verifyRouted(ctxWith({ claimVerification: 'shadow' }), CLAIMS, { source, root });
		expect(mocks.runBundle).not.toHaveBeenCalled();
	});
});

describe('the cap with claim checks', () => {
	it('asks only the claims under the cap and marks the rest capped', async () => {
		mocks.resolveBundleRung.mockResolvedValue(rung('decision'));
		mocks.runBundle.mockResolvedValue({
			hasRun: true,
			status: 'complete',
			labels: { verdict: 'supported' },
		});
		const out = await verifyRouted(
			ctxWith({ claimVerification: 'enforce', verifyClaimCapPerMessage: 2 }),
			CLAIMS,
			{ source, root }
		);
		expect(mocks.runBundle).toHaveBeenCalledTimes(2);
		expect([...out.verdicts.keys()]).toEqual(['item:0', 'item:1']);
		expect(out.isCapped).toBe(true);
	});
});
