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
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import PostboxRecipientField from '../PostboxRecipientField.vue';
import { queryResult } from '~/__tests__/queryStubs';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

beforeAll(() => {
	// The chip tooltips/labels flow through vue-i18n now; `useI18n` is a Nuxt
	// auto-import, so it has to exist as a global for the component's setup.
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	// No suggestions — we're exercising chip/keyboard logic, not autocomplete.
	vi.stubGlobal('useConvexQuery', () => queryResult([]));
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
			plugins: [createTestI18n()],
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

describe('PostboxRecipientField — did you mean … ? (plan idea 4)', () => {
	/** Commit a chip the way a user does: type it, press Enter. */
	async function commit(wrapper: ReturnType<typeof mountField>, address: string) {
		const input = wrapper.get('input');
		await input.setValue(address);
		await input.trigger('keydown', { key: 'Enter' });
		return input;
	}

	it('offers a correction after a near-miss domain is committed', async () => {
		const wrapper = mountField({ knownDomains: ['northwind.studio'] });
		await commit(wrapper, 'anna@gmial.com');

		const hint = wrapper.get('[data-testid="postbox-domain-suggestion"]');
		expect(hint.text()).toContain('Did you mean anna@gmail.com?');
	});

	it('stays silent on a domain the mailbox actually writes to', async () => {
		const wrapper = mountField({ knownDomains: ['northwind.studio'] });
		await commit(wrapper, 'ines@northwind.studio');

		expect(wrapper.find('[data-testid="postbox-domain-suggestion"]').exists()).toBe(false);
	});

	it('replaces the mistyped chip in place when the fix is taken', async () => {
		const wrapper = mountField({ modelValue: ['ines@northwind.studio'] });
		await commit(wrapper, 'anna@gmial.com');
		// The parent owns the model; mirror the commit back as v-model would.
		await wrapper.setProps({ modelValue: ['ines@northwind.studio', 'anna@gmial.com'] });
		await wrapper.get('[data-testid="postbox-domain-suggestion"] button').trigger('click');

		const emits = wrapper.emitted('update:modelValue');
		expect(emits?.at(-1)?.[0]).toEqual(['ines@northwind.studio', 'anna@gmail.com']);
		expect(wrapper.find('[data-testid="postbox-domain-suggestion"]').exists()).toBe(false);
	});

	it('keeps the address as typed when the sender says so, and never blocks', async () => {
		const wrapper = mountField();
		await commit(wrapper, 'anna@gmial.com');
		await wrapper.setProps({ modelValue: ['anna@gmial.com'] });
		const buttons = wrapper.findAll('[data-testid="postbox-domain-suggestion"] button');
		await buttons[1]?.trigger('click');

		expect(wrapper.find('[data-testid="postbox-domain-suggestion"]').exists()).toBe(false);
		// The chip the user typed is still there — a suggestion is not a veto.
		expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual(['anna@gmial.com']);
	});

	it('drops the hint when the chip it is about is removed', async () => {
		const wrapper = mountField();
		await commit(wrapper, 'anna@gmial.com');
		await wrapper.setProps({ modelValue: ['anna@gmial.com'] });
		await wrapper.get('[draggable="true"] button').trigger('click');

		expect(wrapper.find('[data-testid="postbox-domain-suggestion"]').exists()).toBe(false);
	});
});

describe('PostboxRecipientField — first-time recipients (plan idea 5)', () => {
	it('marks only the addresses the mailbox has never written to', () => {
		const wrapper = mountField({
			modelValue: ['ines@northwind.studio', 'stranger@acme-corp.io'],
			firstTimeAddresses: ['stranger@acme-corp.io'],
		});
		const chips = wrapper.findAll('[draggable="true"]');
		expect(chips[0]?.find('[data-testid="postbox-first-time-chip"]').exists()).toBe(false);
		expect(chips[1]?.text()).toContain('first time');
	});

	it('says nothing while the mailbox has not answered yet', () => {
		const wrapper = mountField({ modelValue: ['stranger@acme-corp.io'] });
		expect(wrapper.find('[data-testid="postbox-first-time-chip"]').exists()).toBe(false);
	});
});

describe('PostboxRecipientField — per-recipient seal state (plan idea 11)', () => {
	it('marks each chip with its own key verdict', () => {
		const wrapper = mountField({
			modelValue: ['ines@northwind.studio', 'jonas@acme-corp.io'],
			sealStates: [
				{ address: 'ines@northwind.studio', outcome: 'trusted', hasUsableKey: true },
				{ address: 'jonas@acme-corp.io', outcome: 'notFound', hasUsableKey: false },
			],
		});
		const chips = wrapper.findAll('[draggable="true"]');
		expect(chips[0]?.find('[data-testid="postbox-chip-seal-sealed"]').exists()).toBe(true);
		expect(chips[0]?.find('[data-testid="postbox-chip-no-key"]').exists()).toBe(false);
		// The keyless one is named in words, not only glyphed.
		expect(chips[1]?.find('[data-testid="postbox-chip-seal-noKey"]').exists()).toBe(true);
		expect(chips[1]?.text()).toContain('no key');
	});

	it('matches a chip to its verdict regardless of the case it was typed in', () => {
		const wrapper = mountField({
			modelValue: ['Ines@Northwind.Studio'],
			sealStates: [{ address: 'ines@northwind.studio', outcome: 'trusted', hasUsableKey: true }],
		});
		expect(wrapper.find('[data-testid="postbox-chip-seal-sealed"]').exists()).toBe(true);
	});

	it('says nothing about sealing when the composer passed no verdicts', () => {
		const wrapper = mountField({ modelValue: ['ines@northwind.studio'] });
		expect(wrapper.find('[data-testid="postbox-chip-no-key"]').exists()).toBe(false);
		expect(wrapper.html()).not.toContain('postbox-chip-seal');
		// …and the address itself is still rendered.
		expect(wrapper.get('[draggable="true"]').text()).toContain('ines@northwind.studio');
	});

	it('leaves a chip the server has not answered for unmarked', () => {
		const wrapper = mountField({
			modelValue: ['ines@northwind.studio', 'just-typed@acme-corp.io'],
			sealStates: [{ address: 'ines@northwind.studio', outcome: 'trusted', hasUsableKey: true }],
		});
		const chips = wrapper.findAll('[draggable="true"]');
		expect(chips[0]?.find('[data-testid="postbox-chip-seal-sealed"]').exists()).toBe(true);
		expect(chips[1]?.html()).not.toContain('postbox-chip-seal');
		expect(chips[1]?.text()).toContain('just-typed@acme-corp.io');
	});
});
