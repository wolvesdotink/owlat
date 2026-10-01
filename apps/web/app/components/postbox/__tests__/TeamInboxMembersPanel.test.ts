// @vitest-environment happy-dom
/**
 * The team inbox roster's failed read gets the shared error state with a Try
 * again that re-reads the roster (#1099). It used to be a line of text with no
 * way to recover short of leaving the page.
 */
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import TeamInboxMembersPanel from '../TeamInboxMembersPanel.vue';

describe('TeamInboxMembersPanel roster read', () => {
	it('shows a failed roster read with a Try again that refetches it', async () => {
		const refetchMembers = vi.fn();
		const membersQuery = getFunctionName(api.mail.mailboxMembers.members);
		installNuxtStubs({
			...i18nStubs,
			useOrganization: () => ({
				members: ref([]),
				fetchMembers: vi.fn(),
				invite: vi.fn(),
				canManageMembers: ref(false),
			}),
			useConvexQuery: (query: Parameters<typeof getFunctionName>[0]) => {
				const failed = getFunctionName(query) === membersQuery;
				return {
					data: ref(failed ? undefined : 'member'),
					isLoading: ref(false),
					isRefetching: ref(false),
					error: ref(failed ? new Error('[CONVEX Q(x:y)] Server Error') : null),
					refetch: failed ? refetchMembers : vi.fn(),
					reset: vi.fn(),
				};
			},
		});
		const wrapper = mount(TeamInboxMembersPanel, {
			props: { mailboxId: 'mbx_team' as Id<'mailboxes'> },
			global: {
				plugins: [createTestI18n()],
				stubs: { UiAvatar: true, UiConfirmationDialog: true },
			},
		});

		const retry = wrapper.findAll('button').find((button) => button.text() === 'Try again');
		expect(retry).toBeDefined();
		await retry!.trigger('click');
		expect(refetchMembers).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});
});
