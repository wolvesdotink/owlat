/**
 * The worker versions card on System & updates: per worker service, the
 * builds that reported in the last 7 days with their verdicts, warnings from
 * the per-service summary (not the capped list), the version skew, a named
 * empty state, the read error, and rows that age past the live window while
 * no new report arrives.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

import WorkerVersionsCard from '../WorkerVersionsCard.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

type Service = 'imap' | 'mail-sync' | 'mta' | 'code-worker';
type Verdict = 'current' | 'supported' | 'unsupported' | 'ahead';

const T0 = Date.UTC(2026, 9, 1, 12);

// The card ages rows on its own clock; the fixtures were reported at T0.
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
});
afterEach(() => {
	vi.useRealTimers();
});

const server = (hostLabel: string, wireVersion: number, verdict: Verdict, isLive = true) => ({
	instanceId: `proc-${hostLabel}`,
	hostLabel,
	owlatVersion: '0.6.17',
	wireVersion,
	startedAt: T0,
	lastSeenAt: T0,
	verdict,
	isLive,
});

type Server = ReturnType<typeof server>;

function service(
	name: Service,
	overrides: {
		servers?: Server[];
		backendWireVersion?: number;
		minSupportedWireVersion?: number;
		oldestWireVersionSeen?: number | null;
		legacySeenAt?: number | null;
		isListTruncated?: boolean;
	} = {}
) {
	const servers = overrides.servers ?? [];
	const wires = servers.map((s) => s.wireVersion);
	const legacySeenAt = overrides.legacySeenAt ?? null;
	if (legacySeenAt !== null) wires.push(0);
	return {
		service: name,
		backendWireVersion: overrides.backendWireVersion ?? 1,
		minSupportedWireVersion: overrides.minSupportedWireVersion ?? 0,
		servers,
		isListTruncated: overrides.isListTruncated ?? false,
		oldestWireVersionSeen:
			overrides.oldestWireVersionSeen !== undefined
				? overrides.oldestWireVersionSeen
				: wires.length
					? Math.min(...wires)
					: null,
		newestWireVersionSeen: servers.length ? Math.max(...servers.map((s) => s.wireVersion)) : null,
		legacySeenAt,
		isLegacyInWindow: legacySeenAt !== null,
	};
}

type ServiceStatus = ReturnType<typeof service>;

function status(entries: Partial<Record<Service, ServiceStatus>> = {}) {
	return {
		windowDays: 7,
		liveWindowMs: 15 * 60_000,
		services: (['imap', 'mail-sync', 'mta', 'code-worker'] as const).map(
			(name) => entries[name] ?? service(name)
		),
	};
}

function mountCard(data: unknown, error: Error | null = null) {
	const refetch = vi.fn();
	vi.stubGlobal('useConvexQuery', () => ({
		data: computed(() => data),
		error: computed(() => error),
		refetch,
	}));
	const wrapper = mount(WorkerVersionsCard, {
		global: {
			plugins: [createTestI18n()],
			stubs: { UiQueryBoundary: { template: '<div data-test="boundary" />' } },
		},
	});
	return { wrapper, refetch };
}

const section = (wrapper: ReturnType<typeof mountCard>['wrapper'], name: Service) =>
	wrapper.find(`[data-test="worker-service-${name}"]`);

describe('WorkerVersionsCard', () => {
	it('lists every service with its contract and the builds that reported', () => {
		const { wrapper } = mountCard(
			status({
				mta: service('mta', {
					servers: [server('mta-1', 1, 'current'), server('mta-2', 1, 'current', false)],
				}),
				imap: service('imap', {
					backendWireVersion: 3,
					minSupportedWireVersion: 2,
					servers: [server('imap-1', 3, 'current')],
				}),
			})
		);

		expect(wrapper.findAll('section').map((s) => s.find('h4').text())).toEqual([
			'IMAP server',
			'Mail sync',
			'MTA',
			'Code worker',
		]);
		const imap = section(wrapper, 'imap');
		expect(imap.text()).toContain('Backend speaks wire version 3, serves versions 2 to 3');
		expect(imap.text()).toContain('(wire version 3)');

		const rows = section(wrapper, 'mta').findAll('tbody tr');
		expect(rows).toHaveLength(2);
		expect(rows[0]!.text()).toContain('mta-1');
		expect(rows[0]!.text()).toContain('Current');
		expect(rows[0]!.text()).not.toContain('stopped reporting');
		expect(rows[1]!.text()).toContain('stopped reporting');

		expect(section(wrapper, 'mail-sync').text()).toContain('Nothing reported in the last 7 days.');
		expect(wrapper.find('[role="status"]').exists()).toBe(false);
		expectFullyLocalized(wrapper);
	});

	it('shows the skew when one service runs two wire versions', () => {
		const { wrapper } = mountCard(
			status({
				imap: service('imap', {
					backendWireVersion: 3,
					minSupportedWireVersion: 2,
					servers: [server('new', 3, 'current'), server('old', 2, 'supported')],
				}),
			})
		);

		expect(section(wrapper, 'imap').find('[data-test="skew"]').text()).toContain(
			'Wire versions 2 to 3 reported in the last 7 days.'
		);
		expect(section(wrapper, 'mta').find('[data-test="skew"]').exists()).toBe(false);
		expectFullyLocalized(wrapper);
	});

	it('warns per service from the summary, even past the listed rows', () => {
		const { wrapper } = mountCard(
			status({
				'mail-sync': service('mail-sync', {
					minSupportedWireVersion: 1,
					servers: [server('new', 1, 'current')],
					oldestWireVersionSeen: 0,
					isListTruncated: true,
				}),
				mta: service('mta', { servers: [server('ahead', 2, 'ahead')] }),
			})
		);

		const mailSync = section(wrapper, 'mail-sync');
		// A window of one version is not a range.
		expect(mailSync.text()).toContain('Backend speaks and serves wire version 1 only');
		expect(mailSync.find('[role="status"]').text()).toContain(
			'A worker older than this backend supports reported in the last 7 days.'
		);
		expect(mailSync.text()).toContain('Showing the 1 most recent.');
		expect(section(wrapper, 'mta').find('[role="status"]').text()).toContain(
			'A worker newer than this backend reported in. Update the backend first.'
		);
		expect(section(wrapper, 'code-worker').find('[role="status"]').exists()).toBe(false);
		expectFullyLocalized(wrapper);
	});

	it('warns about a login through an IMAP server from before version reporting', () => {
		const { wrapper } = mountCard(
			status({
				imap: service('imap', {
					backendWireVersion: 3,
					minSupportedWireVersion: 2,
					legacySeenAt: T0,
				}),
			})
		);

		const imap = section(wrapper, 'imap');
		expect(imap.find('[role="status"]').text()).toContain(
			'An IMAP server from 0.6.7 or older handled a login'
		);
		expect(imap.text()).toContain('Nothing reported in the last 7 days.');
	});

	it('marks a row stopped once the live window passes without a new report', async () => {
		const { wrapper } = mountCard(
			status({ mta: service('mta', { servers: [server('mta-1', 1, 'current')] }) })
		);
		const row = () => section(wrapper, 'mta').find('tbody tr');
		expect(row().text()).not.toContain('stopped reporting');

		await vi.advanceTimersByTimeAsync(14 * 60_000);
		expect(row().text()).not.toContain('stopped reporting');

		await vi.advanceTimersByTimeAsync(90_000);
		expect(row().text()).toContain('stopped reporting');
	});

	it('shows the read error instead of the empty state', () => {
		const { wrapper } = mountCard(undefined, new Error('Forbidden'));

		expect(wrapper.find('[data-test="boundary"]').exists()).toBe(true);
		expect(wrapper.text()).not.toContain('Nothing reported');
	});

	it('says it is loading before the first answer', () => {
		const { wrapper } = mountCard(undefined);

		expect(wrapper.text()).toContain('Loading worker versions…');
	});
});
