// @vitest-environment happy-dom
/**
 * PostboxThreadRow — the danger-only sender-trust marker (UX plan idea 51).
 *
 * The list is where phishing gets clicked, so the three accusatory verdicts have
 * to be legible before a thread is opened. What this pins is the SILENCE as much
 * as the marker: a verified sender, an unauthenticated one and a legacy row with
 * no verdicts at all render nothing, which is what keeps the list from becoming
 * a wall of shields.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import type { Id } from '@owlat/api/dataModel';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import PostboxThreadRow, { type PostboxThreadRowMessage } from '../PostboxThreadRow.vue';
import PostboxRowCore from '../PostboxRowCore.vue';

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

const iconStub = { props: ['name'], template: '<span :data-icon="name" />' };
const nuxtLinkStub = { props: ['to'], template: '<a :href="to"><slot /></a>' };
// Renderless: hands the row the scoped-slot handlers it binds, no popover.
const contextMenuStub = {
	props: ['items'],
	template: '<slot :on-contextmenu="() => {}" :on-keydown="() => {}" />',
};
const avatarStub = { props: ['name', 'email', 'size'], template: '<span />' };

const BASE: PostboxThreadRowMessage = {
	_id: 'msg-1' as Id<'mailMessages'>,
	fromAddress: 'billing@brightpath-finance.co',
	fromName: 'Brightpath Finance',
	subject: 'Urgent: update your payment details',
	snippet: 'Your account will be suspended unless…',
	receivedAt: 1_700_000_000_000,
	flagSeen: false,
	flagFlagged: false,
	hasAttachments: false,
};

function mountRow(msg: Partial<PostboxThreadRowMessage>, trustMarkers = true) {
	return mount(PostboxThreadRow, {
		props: {
			msg: { ...BASE, ...msg },
			folderRole: 'inbox',
			virtualize: false,
			selected: false,
			focused: false,
			active: false,
			trustMarkers,
		},
		global: {
			plugins: [createTestI18n()],
			components: {
				PostboxRowCore,
				Icon: iconStub,
				NuxtLink: nuxtLinkStub,
				UiContextMenu: contextMenuStub,
				UiAvatar: avatarStub,
				PostboxThreadRowFollowUp: { template: '<span />' },
				PostboxSwipeTrack: { template: '<div><slot /></div>' },
			},
			mocks: {
				formatThreadTimestamp: () => '2h',
				resolveComponent: () => 'a',
			},
		},
	});
}

const MARKER = '[data-testid="row-trust-marker"]';

describe('PostboxThreadRow sender-trust marker', () => {
	it('marks a DMARC failure and names it in the accessible label', () => {
		const w = mountRow({ dmarcResult: 'fail', dmarcPolicy: 'reject' });
		const marker = w.find(MARKER);
		expect(marker.exists()).toBe(true);
		expect(marker.text()).toBe('Failed sender check');
		expect(marker.attributes('aria-label')).toContain(
			"it failed that domain's authentication checks"
		);
		expect(w.find('li').classes()).toContain('pbx-row-danger');
	});

	it('marks the misaligned (impersonation) shape', () => {
		// A pass that belongs to a DIFFERENT domain than the visible From, with no
		// DMARC verdict of its own — the misaligned branch, not the failed one.
		const w = mountRow({
			fromAddress: 'ceo@acme.com',
			spfResult: 'pass',
			envelopeFromDomain: 'bulk-sender.example',
		});
		const marker = w.find(MARKER);
		expect(marker.text()).toBe('Sender not authorized');
		expect(marker.attributes('aria-label')).toContain('bulk-sender.example');
	});

	it('marks a look-alike of a known contact domain even when the sender is verified', () => {
		const w = mountRow({
			fromAddress: 'billing@brightpath-finance.co',
			spfResult: 'pass',
			envelopeFromDomain: 'brightpath-finance.co',
			dmarcResult: 'pass',
			senderHeuristics: { lookalikeOfContactDomain: 'brightpath.com' },
		});
		const marker = w.find(MARKER);
		expect(marker.exists()).toBe(true);
		expect(marker.text()).toBe('Look-alike sender');
		expect(marker.attributes('aria-label')).toContain('brightpath.com');
	});

	it('stays silent for a verified sender', () => {
		const w = mountRow({
			fromAddress: 'hello@acme.com',
			spfResult: 'pass',
			envelopeFromDomain: 'acme.com',
			dmarcResult: 'pass',
		});
		expect(w.find(MARKER).exists()).toBe(false);
		expect(w.find('li').classes()).not.toContain('pbx-row-danger');
	});

	it('stays silent for an unauthenticated sender (unknown is not an accusation)', () => {
		const w = mountRow({ spfResult: 'none', dkimResult: 'none' });
		expect(w.find(MARKER).exists()).toBe(false);
	});

	it('stays silent for a legacy row that carries no verdicts', () => {
		expect(mountRow({}).find(MARKER).exists()).toBe(false);
	});

	it('renders nothing when the flag is off, even on a failed sender', () => {
		const w = mountRow({ dmarcResult: 'fail' }, false);
		expect(w.find(MARKER).exists()).toBe(false);
		expect(w.find('li').classes()).not.toContain('pbx-row-danger');
	});
});
