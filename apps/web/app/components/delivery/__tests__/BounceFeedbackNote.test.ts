/**
 * The Deliverability Center's note for a transport whose bounce and complaint
 * reports cannot come back. The local stack's seed has no transport without
 * its webhook key, so this suite is the proof of the state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';

import BounceFeedbackNote from '../BounceFeedbackNote.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

Object.assign(globalThis, i18nStubs);

type Stream = { canSend: boolean; feedbackMissing: string[] };
let streams: { transactional: Stream; campaign: Stream } | undefined;

beforeEach(() => {
	streams = undefined;
	vi.stubGlobal('useOrganizationQuery', () => ({
		data: ref(streams ? { streams } : undefined),
	}));
});

function mountNote() {
	return mount(BounceFeedbackNote, {
		global: {
			plugins: [createTestI18n()],
			stubs: { NuxtLink: { props: ['to'], template: '<a :data-to="to"><slot /></a>' } },
		},
	});
}

describe('BounceFeedbackNote', () => {
	it('renders nothing while reports can arrive', () => {
		streams = {
			transactional: { canSend: true, feedbackMissing: [] },
			campaign: { canSend: true, feedbackMissing: [] },
		};
		expect(mountNote().find('[data-testid="bounce-feedback-note"]').exists()).toBe(false);
	});

	it('names the unset key once and links the delivery provider page', () => {
		streams = {
			transactional: { canSend: true, feedbackMissing: ['MTA_WEBHOOK_SECRET'] },
			campaign: { canSend: true, feedbackMissing: ['MTA_WEBHOOK_SECRET'] },
		};
		const note = mountNote().find('[data-testid="bounce-feedback-note"]');
		expect(note.text()).toContain('Bounces and complaints cannot reach Owlat');
		expect(note.text().match(/MTA_WEBHOOK_SECRET/g)).toHaveLength(1);
		expect(note.find('a').attributes('data-to')).toBe('/dashboard/admin/delivery/transport');
	});

	it('says nothing about a stream that cannot send at all (the transport gate covers it)', () => {
		streams = {
			transactional: { canSend: false, feedbackMissing: ['MTA_WEBHOOK_SECRET'] },
			campaign: { canSend: false, feedbackMissing: ['MTA_WEBHOOK_SECRET'] },
		};
		expect(mountNote().find('[data-testid="bounce-feedback-note"]').exists()).toBe(false);
	});
});
