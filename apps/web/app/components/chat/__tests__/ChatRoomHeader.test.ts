// @vitest-environment happy-dom
/**
 * The "linked email" badge names a Team Inbox conversation. The server returns
 * the linked-thread view only to shared-inbox readers, so the header shows the
 * badge only when the page has that view, not whenever the room carries a link.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';

import ChatRoomHeader from '../ChatRoomHeader.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useOrganization: () => ({ canManageMembers: ref(false) }),
	});
});

const iconStub = { props: ['name'], template: '<span />' };

function mountHeader(canSeeLinkedEmail: boolean) {
	return mount(ChatRoomHeader, {
		props: {
			room: {
				_id: 'room1',
				kind: 'channel',
				name: 'support',
				visibility: 'public',
				linkedInboxThreadId: 'thread1',
				isMember: true,
				myRole: 'member',
			},
			memberCount: 3,
			canSeeLinkedEmail,
		} as never,
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: iconStub },
		},
	});
}

describe('ChatRoomHeader linked email badge', () => {
	it('is hidden from a viewer who cannot read the linked thread', () => {
		expect(mountHeader(false).text().toLowerCase()).not.toContain('linked email');
	});

	it('is shown to a viewer who can read the linked thread', () => {
		expect(mountHeader(true).text().toLowerCase()).toContain('linked email');
	});
});
