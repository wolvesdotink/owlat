// @vitest-environment happy-dom
/**
 * Which mailboxes the Preferences mailbox list shows.
 *
 * `identity.list` returns only the caller's own mailboxes and the team inboxes
 * they belong to, admins included. The admin rename/delete list needs every
 * mailbox in the organization, so for admins it reads the admin-only
 * `identity.listOrgMailboxes` instead; members keep the Postbox list and never
 * subscribe to the admin query.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PreferencesMailboxList from '../PreferencesMailboxList.vue';

const ORG_LIST = getFunctionName(api.mail.mailbox.identity.listOrgMailboxes);

function row(id: string, address: string) {
	return { _id: id, address, displayName: address, status: 'active', scope: 'personal' };
}

const OWN = [row('mb_own', 'me@owlat.test')];
const ORG = [row('mb_own', 'me@owlat.test'), row('mb_mate', 'mate@owlat.test')];

const isAdmin = ref(false);
const orgQueryArgs: unknown[] = [];

beforeEach(() => {
	orgQueryArgs.length = 0;
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('usePermissions', () => ({ isAdmin: computed(() => isAdmin.value) }));
	vi.stubGlobal('usePostboxMailbox', () => ({
		mailboxes: computed(() => OWN),
		isLoading: ref(false),
	}));
	vi.stubGlobal('useConvexQuery', (fn: Parameters<typeof getFunctionName>[0], args: unknown) => {
		expect(getFunctionName(fn)).toBe(ORG_LIST);
		const resolved = computed(() => (typeof args === 'function' ? args() : args));
		orgQueryArgs.push(resolved.value);
		return {
			data: computed(() => (resolved.value === 'skip' ? undefined : ORG)),
			isLoading: ref(false),
		};
	});
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
	vi.stubGlobal('useInboxes', () => ({ byId: computed(() => new Map()) }));
});

function mountList() {
	return mount(PreferencesMailboxList, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				InboxChip: true,
				NuxtLink: { template: '<a><slot /></a>' },
				UiModal: true,
				UiConfirmationDialog: true,
				UiButton: true,
				I18nT: true,
			},
		},
	});
}

function addresses(wrapper: ReturnType<typeof mountList>): string[] {
	return wrapper.findAll('li .truncate').map((node) => node.text());
}

describe('PreferencesMailboxList', () => {
	it('shows an admin every organization mailbox from listOrgMailboxes', () => {
		isAdmin.value = true;
		const wrapper = mountList();
		expect(orgQueryArgs).toEqual([{}]);
		expect(addresses(wrapper)).toEqual(['me@owlat.test', 'mate@owlat.test']);
	});

	it('shows a member their own mailboxes and skips the admin query', () => {
		isAdmin.value = false;
		const wrapper = mountList();
		expect(orgQueryArgs).toEqual(['skip']);
		expect(addresses(wrapper)).toEqual(['me@owlat.test']);
	});
});
