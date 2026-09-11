/**
 * Shared module-mock harness for the `sendToMx` suites.
 *
 * The sender's unit tests drive the REAL send path and stub only the seams
 * around it: the SMTP client transport, the connection pool, MX/DANE/STS
 * discovery, the DKIM key store and the logger. Each phase suite registers the
 * same set of mocks, so they are built here once.
 *
 * This module is loaded from inside `vi.hoisted`, i.e. BEFORE any mock is
 * registered. It must therefore import nothing but `vitest` — importing a
 * module that is about to be mocked would load the real one first.
 */

import { vi, type Mock } from 'vitest';

/** The two-MX destination every suite starts from. */
export const DEFAULT_MX_HOSTS = [
	{ exchange: 'mx1.example.com', priority: 10 },
	{ exchange: 'mx2.example.com', priority: 20 },
] as const;

export interface SenderHarness {
	connectMock: Mock;
	sendEnvelopeMock: Mock;
	quitMock: Mock;
	acquireMock: Mock;
	releaseMock: Mock;
	evictConnectionMock: Mock;
	takeConnectionMock: Mock;
	storeConnectionMock: Mock;
	attachConnectionMock: Mock;
	leaseValidMock: Mock;
	/** Module factories, one per `vi.mock` call in a suite's preamble. */
	ipPoolModule: () => Record<string, unknown>;
	smtpClientModule: (actual: Record<string, unknown>) => Record<string, unknown>;
	connectionPoolModule: () => Record<string, unknown>;
	mxResolverModule: () => Record<string, unknown>;
	daneMxResolverModule: () => Record<string, unknown>;
	mtaStsModule: (actual: Record<string, unknown>) => Record<string, unknown>;
	dkimModule: () => Record<string, unknown>;
	daneResolverModule: () => Record<string, unknown>;
	verpModule: () => Record<string, unknown>;
	queueGroupsModule: () => Record<string, unknown>;
	loggerModule: () => Record<string, unknown>;
}

export function createSenderHarness(): SenderHarness {
	const connectMock = vi.fn();
	const sendEnvelopeMock = vi.fn();
	const quitMock = vi.fn();
	const acquireMock = vi.fn();
	const releaseMock = vi.fn();
	const evictConnectionMock = vi.fn();
	// takeConnection returns undefined by default (no reuse), so each attempt opens
	// a fresh SmtpConnection via connectMock — the seam these unit tests inspect.
	// The socket-reuse guardrails themselves live in connectionReuse.integration.test.ts.
	const takeConnectionMock = vi.fn().mockResolvedValue(undefined);
	const storeConnectionMock = vi.fn();
	const attachConnectionMock = vi.fn().mockReturnValue(true);
	const leaseValidMock = vi.fn();

	return {
		connectMock,
		sendEnvelopeMock,
		quitMock,
		acquireMock,
		releaseMock,
		evictConnectionMock,
		takeConnectionMock,
		storeConnectionMock,
		attachConnectionMock,
		leaseValidMock,

		ipPoolModule: () => ({ isIpEligibilityLeaseValid: leaseValidMock }),

		smtpClientModule: (actual) => ({
			...actual,
			SmtpConnection: { connect: connectMock },
			sendEnvelope: sendEnvelopeMock,
			quit: quitMock,
		}),

		connectionPoolModule: () => ({
			pool: {
				acquire: acquireMock,
				release: releaseMock,
				takeConnection: takeConnectionMock,
				storeConnection: storeConnectionMock,
				attachConnection: attachConnectionMock,
				evictConnection: evictConnectionMock,
			},
			PoolOverCapError: class PoolOverCapError extends Error {
				constructor(readonly mxHost: string) {
					super('cap');
					this.name = 'PoolOverCapError';
				}
			},
		}),

		mxResolverModule: () => ({
			resolveMxDestination: vi.fn().mockResolvedValue({
				status: 'deliverable',
				source: 'mx',
				hosts: [...DEFAULT_MX_HOSTS],
			}),
		}),

		daneMxResolverModule: () => ({ resolveDaneMxDestinations: vi.fn() }),

		// Only the MTA-STS policy lookup is stubbed (per-test policy mode);
		// `isMxAllowed` keeps its real RFC 8461 §4.1 wildcard/empty-list semantics so
		// the enforce skip path is exercised honestly. tlsRpt.js is intentionally NOT
		// mocked: the sender's `recordTlsResult` writes to the (mock) Redis and the
		// tests read the result back via `generateReport`, so the policy-context +
		// STS-specific result types it emits are exercised end-to-end.
		mtaStsModule: (actual) => ({ ...actual, getStsTlsOptions: vi.fn() }),

		dkimModule: () => ({ getDkimOptions: vi.fn().mockResolvedValue(undefined) }),

		// DANE TLSA resolver is stubbed per-test (default: no TLSA, so the DANE
		// branch is inert and the non-DANE path is unchanged).
		daneResolverModule: () => ({
			lookupTlsaRecords: vi.fn().mockResolvedValue({ status: 'no-tlsa' }),
		}),

		verpModule: () => ({
			buildVerpAddress: vi.fn().mockReturnValue('bounce+encoded@bounces.owlat.com'),
		}),

		queueGroupsModule: () => ({ extractDomain: vi.fn().mockReturnValue('example.com') }),

		loggerModule: () => ({
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		}),
	};
}
