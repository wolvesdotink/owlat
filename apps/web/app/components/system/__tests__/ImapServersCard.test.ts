// @vitest-environment happy-dom
/**
 * The IMAP servers card on System & updates (ADR-0063): the servers that
 * reported in the last 7 days with their verdicts, a warning when a server the
 * backend no longer serves (or one from before reporting) was seen, and a named
 * empty state.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

import ImapServersCard from '../ImapServersCard.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

type Server = {
	instanceId: string;
	hostLabel: string;
	owlatVersion: string;
	wireVersion: number;
	startedAt: number;
	lastSeenAt: number;
	verdict: 'current' | 'supported' | 'unsupported' | 'ahead';
};

const T0 = Date.UTC(2026, 9, 1, 12);

function status(overrides: { servers?: Server[]; legacyImapSeenAt?: number | null } = {}) {
	const legacyImapSeenAt = overrides.legacyImapSeenAt ?? null;
	return {
		backendWireVersion: 1,
		minSupportedWireVersion: 0,
		windowDays: 7,
		servers: overrides.servers ?? [],
		legacyImapSeenAt,
		isLegacyInWindow: legacyImapSeenAt !== null,
		oldestWireVersionSeen: null,
		safeToRaiseMinTo: 1,
	};
}

const server = (hostLabel: string, verdict: Server['verdict'], wireVersion = 1): Server => ({
	instanceId: `proc-${hostLabel}`,
	hostLabel,
	owlatVersion: '0.6.8',
	wireVersion,
	startedAt: T0,
	lastSeenAt: T0,
	verdict,
});

function mountCard(data: unknown, error: Error | null = null) {
	const refetch = vi.fn();
	vi.stubGlobal('useConvexQuery', () => ({
		data: computed(() => data),
		error: computed(() => error),
		refetch,
	}));
	const wrapper = mount(ImapServersCard, {
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: true, UiQueryBoundary: { template: '<div data-test="boundary" />' } },
		},
	});
	return { wrapper, refetch };
}

describe('ImapServersCard', () => {
	it('lists each server with its release and verdict', () => {
		const { wrapper } = mountCard(
			status({
				servers: [server('a1b2c3d4e5f6', 'current'), server('0f9e8d7c6b5a', 'supported', 0)],
			})
		);

		const rows = wrapper.findAll('tbody tr');
		expect(rows).toHaveLength(2);
		expect(rows[0]!.text()).toContain('a1b2c3d4e5f6');
		expect(rows[0]!.text()).toContain('0.6.8');
		expect(rows[0]!.text()).toContain('(wire version 1)');
		expect(rows[0]!.text()).toContain('Current');
		expect(rows[1]!.text()).toContain('Older, supported');
		expect(wrapper.find('[role="status"]').exists()).toBe(false);
		expectFullyLocalized(wrapper);
	});

	it('warns when a server the backend no longer serves reported', () => {
		const { wrapper } = mountCard(status({ servers: [server('old', 'unsupported', 0)] }));

		expect(wrapper.text()).toContain('Not supported');
		expect(wrapper.find('[role="status"]').text()).toContain(
			'It does not start until you update the IMAP container.'
		);
	});

	it('warns when a server newer than the backend is waiting', () => {
		const { wrapper } = mountCard(status({ servers: [server('new', 'ahead', 2)] }));

		expect(wrapper.find('[role="status"]').text()).toContain(
			'It does not serve mail until the backend is updated.'
		);
	});

	it('warns about a login through a server from before version reporting', () => {
		const { wrapper } = mountCard(status({ legacyImapSeenAt: T0 }));

		expect(wrapper.find('[role="status"]').text()).toContain(
			'An IMAP server from before version reporting (0.6.7 or older) handled a login'
		);
		// The legacy server never reports, so the table stays empty under the warning.
		expect(wrapper.text()).toContain('No IMAP server reported in the last 7 days.');
		expectFullyLocalized(wrapper);
	});

	it('names the empty state when nothing reported', () => {
		const { wrapper } = mountCard(status());

		expect(wrapper.text()).toContain('No IMAP server reported in the last 7 days.');
		expect(wrapper.find('table').exists()).toBe(false);
		expect(wrapper.find('[role="status"]').exists()).toBe(false);
	});

	it('shows the read error instead of the empty state', () => {
		const { wrapper } = mountCard(undefined, new Error('Forbidden'));

		expect(wrapper.find('[data-test="boundary"]').exists()).toBe(true);
		expect(wrapper.text()).not.toContain('No IMAP server reported');
	});

	it('says it is loading before the first answer', () => {
		const { wrapper } = mountCard(undefined);

		expect(wrapper.text()).toContain('Loading IMAP servers…');
	});
});
