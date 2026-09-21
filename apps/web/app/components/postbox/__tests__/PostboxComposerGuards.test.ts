// @vitest-environment happy-dom
/**
 * PostboxComposerGuards — the three pre-send warning surfaces, rendered.
 *
 * The composable's suite proves the DECISIONS; this one proves the copy a
 * sender actually reads: every message resolves out of the real `en` catalog
 * (a keypath typo would render `components.postbox.…` at them), the attachment
 * dialog quotes the phrase that fired, the alignment dialog speaks the
 * transport's own reason, and the first-time line is one line with two ways out
 * — never a modal.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import PostboxComposerGuards from '../PostboxComposerGuards.vue';
import type { ComposerGuards } from '~/composables/postbox/usePostboxComposerGuards';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

/** Captures the confirmation dialogs' resolved copy without rendering one. */
const dialogStub = {
	props: ['open', 'title', 'description', 'confirmText', 'cancelText', 'variant'],
	template: '<div class="dialog" :data-open="open" :data-title="title">{{ description }}</div>',
};

function gate(open = false) {
	return { open, confirm: vi.fn(), dismiss: vi.fn(), setOpen: vi.fn(), block: vi.fn() };
}

function mountGuards(over: Partial<Record<string, unknown>> = {}) {
	const guards = {
		knownDomains: [],
		firstTimeAddresses: [],
		preflight: [],
		alignmentWarning: null,
		attachmentHint: null,
		alignment: gate(),
		attachment: gate(),
		firstTime: gate(),
		blockSend: vi.fn(),
		...over,
	} as unknown as ComposerGuards;
	const wrapper = mount(PostboxComposerGuards, {
		props: { guards },
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: true, UiConfirmationDialog: dialogStub },
		},
	});
	return { wrapper, guards };
}

const dialogs = (wrapper: ReturnType<typeof mountGuards>['wrapper']) => wrapper.findAll('.dialog');

describe('PostboxComposerGuards — alignment dialog (idea 3)', () => {
	it('speaks the transport’s own reason', () => {
		const reason = 'This transport signs mail as another domain.';
		const { wrapper } = mountGuards({
			alignment: gate(true),
			alignmentWarning: { tone: 'error', label: 'x', detail: reason, blocked: true },
		});
		const dialog = dialogs(wrapper)[0]!;
		expect(dialog.attributes('data-open')).toBe('true');
		expect(dialog.attributes('data-title')).toBe('This message is likely to bounce');
		expect(dialog.text()).toBe(reason);
	});

	it('falls back to plain language when the check offered no reason', () => {
		const { wrapper } = mountGuards({ alignment: gate(true) });
		expect(dialogs(wrapper)[0]!.text()).toBe(
			'This sending address has a problem that mailboxes will reject. Send anyway?'
		);
	});
});

describe('PostboxComposerGuards — attachment dialog (idea 15)', () => {
	it('quotes back the phrase that fired', () => {
		const { wrapper } = mountGuards({
			attachment: gate(true),
			attachmentHint: { kind: 'mention', phrase: 'attached' },
		});
		const dialog = dialogs(wrapper)[1]!;
		expect(dialog.attributes('data-title')).toBe('Attachment missing?');
		expect(dialog.text()).toContain('“attached”');
	});

	it('says something different about a forward that lost its attachment', () => {
		const { wrapper } = mountGuards({
			attachment: gate(true),
			attachmentHint: { kind: 'forwardedQuote', phrase: 'see attached' },
		});
		const dialog = dialogs(wrapper)[1]!;
		expect(dialog.attributes('data-title')).toBe('Forwarded attachment missing?');
		expect(dialog.text()).toContain('forwarding');
	});
});

describe('PostboxComposerGuards — first-time recipients (idea 5)', () => {
	it('is one dismissible line, not a dialog', () => {
		const { wrapper, guards } = mountGuards({
			firstTime: gate(true),
			firstTimeAddresses: ['stranger@acme-corp.io'],
		});
		const line = wrapper.get('[data-testid="postbox-first-time-confirm"]');
		expect(line.text()).toContain('First time writing to stranger@acme-corp.io');

		const buttons = line.findAll('button');
		expect(buttons).toHaveLength(2);
		buttons[0]!.trigger('click');
		buttons[1]!.trigger('click');
		expect(guards.firstTime.confirm).toHaveBeenCalledOnce();
		expect(guards.firstTime.dismiss).toHaveBeenCalledOnce();
	});

	it('lists every stranger, and nothing when there are none', () => {
		const { wrapper } = mountGuards({
			firstTime: gate(true),
			firstTimeAddresses: ['a@x.test', 'b@y.test'],
		});
		expect(wrapper.get('[data-testid="postbox-first-time-confirm"]').text()).toContain(
			'a@x.test, b@y.test'
		);

		const quiet = mountGuards().wrapper;
		expect(quiet.find('[data-testid="postbox-first-time-confirm"]').exists()).toBe(false);
	});
});
