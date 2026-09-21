// @vitest-environment happy-dom
/**
 * TeamInboxCard — one team inbox's row on the admin roster page.
 *
 * The row decides two things this suite pins down, both of which read as small
 * and are not:
 *
 *  - WHEN THE IMPORT AFFORDANCE EXISTS. Every shared-migration entry point goes
 *    through `requireMailboxAccess`, which refuses a non-active mailbox, and a
 *    hosted inbox has no external history to pull in at all — so offering the
 *    toggle on either would open a panel that can only report an error.
 *  - THE INLINE SUMMARY. An import runs for hours and everyone on the roster
 *    sees its effects, so the row itself has to say one is in flight rather than
 *    hiding that behind a panel only the admin who started it ever opened.
 *
 * The card reports intent through events — the page above owns the panels and
 * the mutations — so a click is asserted as an emit, not as a state change.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, defineComponent, h, type Ref } from 'vue';
import { getFunctionName, type FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

import TeamInboxCard from '../TeamInboxCard.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

type SharedInbox = FunctionReturnType<typeof api.mail.mailboxMembers.listShared>[number];
type Status = FunctionReturnType<typeof api.mail.migrationShared.getStatusShared>;

const MAILBOX_ID = 'mailbox_support' as Id<'mailboxes'>;

const importStatus: Ref<Status> = ref(null);

function inbox(overrides: Partial<SharedInbox> = {}): SharedInbox {
	return {
		_id: MAILBOX_ID,
		address: 'support@owlat.test',
		displayName: 'Support',
		status: 'active',
		kind: 'external',
		createdAt: Date.UTC(2026, 0, 12),
		memberCount: 1,
		members: [
			{
				authUserId: 'user-admin',
				role: 'owner',
				name: 'Ada Admin',
				email: 'ada@owlat.test',
				image: null,
			},
		],
		pendingInvites: [],
		externalStatus: 'connected',
		externalLastError: null,
		...overrides,
	} as SharedInbox;
}

beforeEach(() => {
	importStatus.value = null;
	vi.stubGlobal('useConvexQuery', (reference: Parameters<typeof getFunctionName>[0]) => ({
		data:
			getFunctionName(reference) === getFunctionName(api.mail.migrationShared.getStatusShared)
				? importStatus
				: ref(null),
		isLoading: ref(false),
		error: ref(null),
	}));
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const panelStub = defineComponent({ setup: () => () => h('div') });

function mountCard(overrides: Partial<SharedInbox> = {}) {
	return mount(TeamInboxCard, {
		props: {
			inbox: inbox(overrides),
			expanded: false,
			reconnecting: false,
			importing: false,
			sealedMailEnabled: false,
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiIconBox: panelStub,
				UiAvatar: panelStub,
				PostboxTeamInboxMembersPanel: panelStub,
				PostboxTeamInboxImportCard: panelStub,
				PostboxMailboxConnectForm: panelStub,
			},
		},
	});
}

const toggle = '[data-testid="team-inbox-import-toggle"]';

describe('TeamInboxCard', () => {
	it('offers the history import on an active external inbox', () => {
		const wrapper = mountCard();

		expect(wrapper.find(toggle).exists()).toBe(true);
		expect(wrapper.find(toggle).text()).toContain('Import history');
		expectFullyLocalized(wrapper);
	});

	it('hides the import from a hosted inbox, which has no history to pull in', () => {
		const wrapper = mountCard({ kind: 'hosted', externalStatus: null });

		expect(wrapper.find(toggle).exists()).toBe(false);
	});

	it('hides the import from a suspended inbox, which requireMailboxAccess refuses', () => {
		const wrapper = mountCard({ status: 'suspended' });

		expect(wrapper.find(toggle).exists()).toBe(false);
	});

	it('asks the page to open the panel rather than opening it itself', async () => {
		const wrapper = mountCard();

		await wrapper.find(toggle).trigger('click');

		expect(wrapper.emitted('toggleImport')).toHaveLength(1);
	});

	it('reports an import in flight on the row itself, with its running count', () => {
		importStatus.value = {
			status: 'importing',
			messagesTotal: 8300,
			messagesImported: 1204,
			messagesIndexed: 0,
		} as NonNullable<Status>;
		const wrapper = mountCard();

		const summary = wrapper.find('[data-testid="team-inbox-import-summary"]');
		expect(summary.exists()).toBe(true);
		expect(summary.text()).toContain('History import in progress · 1,204 of 8,300');
		expectFullyLocalized(wrapper);
	});

	it('says nothing on the row when there is no import to report', () => {
		importStatus.value = { status: 'completed', messagesImported: 8300 } as NonNullable<Status>;
		const wrapper = mountCard();

		expect(wrapper.find('[data-testid="team-inbox-import-summary"]').exists()).toBe(false);
	});
});
