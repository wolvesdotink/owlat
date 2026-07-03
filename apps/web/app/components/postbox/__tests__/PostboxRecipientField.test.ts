// @vitest-environment happy-dom
/**
 * PostboxRecipientField behavior:
 *   - Backspace on an empty field pops the LAST chip back into the input as
 *     editable text (Gmail behavior) rather than deleting it outright, and
 *   - a recipient outside the user's own domain(s) renders with the external
 *     cue (ring + "outside <domain>" tooltip).
 *
 * The autocomplete query is stubbed out; only the chip/keyboard logic is under
 * test here (the ranking lives in the backend unit test).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';

import PostboxRecipientField from '../PostboxRecipientField.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

beforeAll(() => {
	// No suggestions — we're exercising chip/keyboard logic, not autocomplete.
	vi.stubGlobal('useConvexQuery', () => ({ data: ref([]) }));
});

const iconStub = { props: ['name'], template: '<span />' };
const avatarStub = { props: ['email', 'name'], template: '<span />' };

function mountField(props: Record<string, unknown> = {}) {
	return mount(PostboxRecipientField, {
		props: {
			modelValue: [],
			mailboxId: 'mbx_1',
			label: 'To',
			...props,
		},
		global: {
			stubs: { Icon: iconStub, UiAvatar: avatarStub },
		},
	});
}

describe('PostboxRecipientField — backspace edits last chip', () => {
	it('pops the last chip into the input instead of deleting it', async () => {
		const wrapper = mountField({ modelValue: ['anna@example.com', 'ben@example.com'] });
		const input = wrapper.get('input');

		await input.trigger('keydown', { key: 'Backspace' });

		// Emitted the model without the last chip…
		const emitted = wrapper.emitted('update:modelValue');
		expect(emitted?.[0]?.[0]).toEqual(['anna@example.com']);
		// …and loaded that chip's address into the input for editing.
		expect((input.element as HTMLInputElement).value).toBe('ben@example.com');
	});

	it('does nothing on backspace when the input already has text', async () => {
		const wrapper = mountField({ modelValue: ['anna@example.com'] });
		const input = wrapper.get('input');
		await input.setValue('typing');

		await input.trigger('keydown', { key: 'Backspace' });

		expect(wrapper.emitted('update:modelValue')).toBeUndefined();
	});
});

describe('PostboxRecipientField — external-domain cue', () => {
	it('flags a chip outside the own domain with the external tooltip', () => {
		const wrapper = mountField({
			modelValue: ['vendor@acme.io', 'colleague@example.com'],
			ownDomains: ['example.com'],
		});
		const chips = wrapper.findAll('[draggable="true"]');
		expect(chips[0]?.attributes('title')).toBe('outside example.com');
		// Internal recipient carries no external tooltip.
		expect(chips[1]?.attributes('title')).toBeUndefined();
	});
});
