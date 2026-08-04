/**
 * THE CONSEQUENCE CHECK ON `POST /api/delivery/apply-transport`.
 *
 * Disconnecting the relay is one of the two actions in this product that can
 * lose weeks of reputation, and the transport endpoint is where it actually
 * happens — from the editor, from the connection wizard, and from anything else
 * that can POST. So the typed phrase is re-checked HERE, exactly as
 * `forceAdvanceCellShare` re-checks its own: the dialog is what an operator
 * sees, not what makes the change safe.
 *
 * The assertions that carry the weight are the ones about what did NOT happen —
 * no live push, no `.env` write — because a refusal that still repointed the
 * deployment is the bug this endpoint would have.
 *
 * The h3/Nuxt request helpers are stubbed and the shared env/push modules
 * mocked, so the route's own control flow is exercised in isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';
import { RELAY_REMOVAL_CONFIRMATION } from '@owlat/shared/deliverabilityIndependence';

const { pushMock, readMock, writeMock, requireOrgAdminMock, queryMock } = vi.hoisted(() => ({
	pushMock: vi.fn(),
	readMock: vi.fn(),
	writeMock: vi.fn(),
	requireOrgAdminMock: vi.fn(),
	queryMock: vi.fn(),
}));

vi.mock('~~/server/utils/requireOrgAdmin', () => ({
	requireOrgAdmin: requireOrgAdminMock,
}));
vi.mock('@owlat/shared/setupEnv', () => ({
	readEnvFile: readMock,
	writeEnvFile: writeMock,
}));
vi.mock('@owlat/shared/convexRuntimeEnv', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@owlat/shared/convexRuntimeEnv')>();
	return { ...actual, pushConvexRuntimeEnv: pushMock };
});

interface ApplyResult {
	ok: boolean;
	message: string;
	applied: boolean;
	requiresRestart: boolean;
	needsRelayRemovalConfirmation?: true;
	relayRemovalConsequence?: string;
}

let body: unknown;

async function callRoute(): Promise<ApplyResult> {
	const mod = await import('../apply-transport.post');
	const handler = mod.default as unknown as (event: unknown) => Promise<ApplyResult>;
	return handler({});
}

/** The draft an operator applies to stop paying the relay. */
function ownMtaPatch(): Record<string, string> {
	return { EMAIL_PROVIDER: 'mta', OUTBOUND_TLS_MODE: 'opportunistic' };
}

/** A relay-to-relay rotation: a second arm survives it, so nothing is removed. */
function relayPatch(): Record<string, string> {
	return { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_live_abc' };
}

/** The removal-safety read the endpoint makes, as the query returns it. */
function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		referenceTransportId: 'ses',
		relayRemoval: {
			kind: 'unsafe',
			dependentCells: ['campaign:gmail', 'automation:yahoo'],
			projectedSafeAt: null,
		},
		...overrides,
	};
}

function answerSummaryWith(value: Record<string, unknown>): void {
	queryMock.mockImplementation(async (query: unknown) => {
		if (
			getFunctionName(query as Parameters<typeof getFunctionName>[0]) ===
			getFunctionName(api.delivery.rampIndependence.getIndependenceSummary)
		) {
			return value;
		}
		throw new Error('unexpected query');
	});
}

beforeEach(() => {
	pushMock.mockReset().mockResolvedValue(undefined);
	writeMock.mockReset().mockResolvedValue(undefined);
	readMock.mockReset().mockResolvedValue({
		CONVEX_ADMIN_KEY: 'convex-self-hosted|deadbeef',
		CONVEX_SITE_URL: 'http://convex:3211',
		// The relay this deployment is on today, so dropping it is a real removal.
		EMAIL_PROVIDER: 'ses',
	});
	queryMock.mockReset();
	answerSummaryWith(summary());
	requireOrgAdminMock.mockReset().mockResolvedValue({ query: queryMock });
	body = { providerEnv: ownMtaPatch() };

	vi.stubGlobal('defineEventHandler', <T>(handler: T) => handler);
	vi.stubGlobal(
		'readBody',
		vi.fn(async () => body)
	);
	vi.stubGlobal('createError', (opts: { statusCode: number; message: string }) =>
		Object.assign(new Error(opts.message), { statusCode: opts.statusCode })
	);
});

describe('apply-transport — disconnecting a relay cells still lean on', () => {
	it('refuses an unconfirmed switch to the own MTA, and changes nothing', async () => {
		const res = await callRoute();

		expect(res.ok).toBe(false);
		expect(res.applied).toBe(false);
		expect(res.message).toContain(RELAY_REMOVAL_CONFIRMATION);
		// The refusal names the consequence, not just the rule — in the SAME words
		// the dialog that collects the phrase uses (`relayRemovalConsequenceCopy`).
		expect(res.message).toContain('2 cells have not graduated yet');
		// And it names the relay the way every screen does, not by its stored kind.
		expect(res.message).toContain('Amazon SES');
		// The flag is what makes the refusal actionable: a client whose own removal
		// read faulted learns from THIS response that a phrase is wanted, and can
		// open its dialog instead of printing the demand with nowhere to meet it.
		expect(res.needsRelayRemovalConfirmation).toBe(true);
		expect(pushMock).not.toHaveBeenCalled();
		expect(writeMock).not.toHaveBeenCalled();
	});

	it('separates the consequence from the instruction to type the phrase', async () => {
		const res = await callRoute();

		// TWO READERS, TWO SHAPES. A dialog renders the consequence directly above
		// its own "Type REMOVE THE RELAY to confirm" label, so a consequence that
		// ends in that instruction states it twice; a script reading the response on
		// its own has no label and needs it. So both are returned, and the sentence
		// the dialog takes carries no instruction.
		expect(res.relayRemovalConsequence).toContain('2 cells have not graduated yet');
		expect(res.relayRemovalConsequence).not.toContain(RELAY_REMOVAL_CONFIRMATION);
		expect(res.message).toBe(
			`${res.relayRemovalConsequence} Type “${RELAY_REMOVAL_CONFIRMATION}” to disconnect it anyway.`
		);
	});

	it('quotes the projected safe date the operator could wait for instead', async () => {
		const safeAt = Date.UTC(2026, 7, 14);
		answerSummaryWith(
			summary({
				relayRemoval: {
					kind: 'unsafe',
					dependentCells: ['campaign:gmail'],
					projectedSafeAt: safeAt,
				},
			})
		);

		const res = await callRoute();

		expect(res.ok).toBe(false);
		expect(res.message).toContain('1 cell has not graduated yet');
		expect(res.message).toContain('waiting until about');
	});

	it('applies the same change once the phrase is typed', async () => {
		body = { providerEnv: ownMtaPatch(), relayRemovalConfirmation: RELAY_REMOVAL_CONFIRMATION };

		const res = await callRoute();

		expect(res.ok).toBe(true);
		expect(res.applied).toBe(true);
		expect(pushMock).toHaveBeenCalledTimes(1);
		const changes = Object.fromEntries(pushMock.mock.calls[0]![2] as Array<[string, string]>);
		expect(changes['EMAIL_PROVIDER']).toBe('mta');
	});

	it('accepts the phrase trimmed and case-folded, and nothing else', async () => {
		body = { providerEnv: ownMtaPatch(), relayRemovalConfirmation: '  remove the relay  ' };
		expect((await callRoute()).ok).toBe(true);

		pushMock.mockClear();
		body = { providerEnv: ownMtaPatch(), relayRemovalConfirmation: 'remove the relayy' };
		expect((await callRoute()).ok).toBe(false);
		expect(pushMock).not.toHaveBeenCalled();
	});

	it('never asks for a phrase when the change keeps a second arm', async () => {
		body = { providerEnv: relayPatch() };

		const res = await callRoute();

		expect(res.ok).toBe(true);
		// Rotating between relays is not a removal, so the removal read is not even
		// made — the endpoint may not turn a credential rotation into a consequence
		// dialog.
		expect(queryMock).not.toHaveBeenCalled();
		expect(pushMock).toHaveBeenCalledTimes(1);
	});

	it('lets the change through when every cell has graduated', async () => {
		answerSummaryWith(summary({ relayRemoval: { kind: 'safe' } }));

		const res = await callRoute();

		expect(res.ok).toBe(true);
		expect(pushMock).toHaveBeenCalledTimes(1);
	});

	it('lets the change through on a deployment that never had a relay', async () => {
		// THE SUMMARY THE QUERY ACTUALLY RETURNS. `getIndependenceSummary` answers
		// `{kind:'safe'}` for every deployment with no reference arm, so a standalone
		// one is not a second shape to recognise here — pinning it as
		// `referenceTransportId: null` beside an UNSAFE removal would pin a state the
		// backend cannot produce, and with it a clause that decides nothing.
		answerSummaryWith(summary({ referenceTransportId: null, relayRemoval: { kind: 'safe' } }));

		expect((await callRoute()).ok).toBe(true);
		expect(pushMock).toHaveBeenCalledTimes(1);
	});

	it('refuses rather than guessing when the removal read cannot be made', async () => {
		queryMock.mockRejectedValue(new Error('backend unavailable'));

		const res = await callRoute();

		// FAIL-CLOSED: a read that did not answer knows nothing about which cells
		// are still leaning on the relay, so it may not answer "safe" for them.
		expect(res.ok).toBe(false);
		expect(res.message).toContain(RELAY_REMOVAL_CONFIRMATION);
		// A count nobody could read is not zero, and the refusal may not say it is.
		expect(res.message).toContain('could not be established');
		expect(res.message).not.toContain('0 cell');
		// And it is still the refusal the phrase clears, so the editor opens its
		// dialog rather than dead-ending on a demand it cannot meet.
		expect(res.needsRelayRemovalConfirmation).toBe(true);
		expect(pushMock).not.toHaveBeenCalled();
		expect(writeMock).not.toHaveBeenCalled();
	});

	it('does not need the backend to answer once the phrase is typed', async () => {
		queryMock.mockRejectedValue(new Error('backend unavailable'));
		body = { providerEnv: ownMtaPatch(), relayRemovalConfirmation: RELAY_REMOVAL_CONFIRMATION };

		expect((await callRoute()).ok).toBe(true);
		expect(pushMock).toHaveBeenCalledTimes(1);
	});
});
