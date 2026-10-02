// @vitest-environment happy-dom
/**
 * The Trusted forwarders card keeps a draft of the list against the live
 * instance settings row. That row re-emits on any write to any of its fields
 * (the TLS and MTA-STS cards on the same page save on change), so the draft
 * may follow the server only while it holds nothing unsaved (#1128).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config, flushPromises, mount } from '@vue/test-utils';
import { ref, type Ref } from 'vue';
import { DEFAULT_TRUSTED_ARC_FORWARDERS } from '@owlat/shared/arcTrust';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const h = vi.hoisted(() => ({
	guard: null as null | ((to: unknown, from: unknown, next: (v?: unknown) => void) => void),
}));

vi.mock('vue-router', () => ({
	onBeforeRouteLeave: (cb: (typeof h)['guard']) => {
		h.guard = cb;
	},
	useRouter: () => ({ push: vi.fn() }),
}));

import { useUnsavedChanges } from '~/composables/useUnsavedChanges';
import TrustedForwardersCard from '../TrustedForwardersCard.vue';

config.global.plugins = [...(config.global.plugins ?? []), createTestI18n()];

interface SettingsRow {
	trustedArcForwarders?: string[];
	isInboundTlsRequired?: boolean;
}

const settings: Ref<SettingsRow | null | undefined> = ref(undefined);
const run = vi.fn();
const showToast = vi.fn();

beforeEach(() => {
	h.guard = null;
	settings.value = {
		trustedArcForwarders: ['lists.example.com', 'forward.example.org'],
		isInboundTlsRequired: true,
	};
	showToast.mockReset();
	run.mockReset();
	// The write lands and the subscription echoes the new row back.
	run.mockImplementation(async (args: { trustedArcForwarders: string[] }) => {
		settings.value = { ...settings.value, trustedArcForwarders: args.trustedArcForwarders };
		return { ok: true };
	});
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('usePermissions', () => ({ canManageOrganization: ref(true) }));
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useConvexQuery', () => ({
		data: settings,
		isLoading: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	}));
	vi.stubGlobal('useBackendOperation', () => ({ run, isLoading: ref(false) }));
	vi.stubGlobal('useUnsavedChanges', useUnsavedChanges);
});

const stubs = {
	UiCard: { template: '<section><slot name="header" /><slot /></section>' },
	UiIconBox: true,
	UiSpinner: true,
	UiQueryBoundary: true,
	Icon: true,
	UiInput: {
		props: ['modelValue'],
		emits: ['update:modelValue'],
		template:
			'<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
	},
	UiButton: {
		props: ['disabled', 'loading', 'variant', 'type'],
		template: '<button :type="type || \'button\'" :disabled="disabled"><slot /></button>',
	},
};

function mountCard() {
	return mount(TrustedForwardersCard, { global: { stubs } });
}

const listed = (wrapper: ReturnType<typeof mountCard>) =>
	wrapper.findAll('[data-testid="trusted-forwarders-list"] li').map((li) => li.text());

const saveButton = (wrapper: ReturnType<typeof mountCard>) =>
	wrapper.findAll('button').find((b) => b.text() === 'Save')!;

async function remove(wrapper: ReturnType<typeof mountCard>, domain: string) {
	await wrapper.find(`button[aria-label="Remove ${domain}"]`).trigger('click');
	await flushPromises();
}

describe('TrustedForwardersCard', () => {
	it('shows the stored list, the defaults when it was never set, and nothing for an explicit []', async () => {
		const wrapper = mountCard();
		await flushPromises();
		expect(listed(wrapper)).toEqual(['lists.example.com', 'forward.example.org']);
		expect(saveButton(wrapper).attributes('disabled')).toBeDefined();

		settings.value = {};
		await flushPromises();
		expect(listed(wrapper)).toEqual([...DEFAULT_TRUSTED_ARC_FORWARDERS]);

		settings.value = { trustedArcForwarders: [] };
		await flushPromises();
		expect(listed(wrapper)).toEqual([]);
		expect(wrapper.text()).toContain('No forwarders are trusted');
	});

	it('keeps an unsaved edit when another field of the settings row is written', async () => {
		const wrapper = mountCard();
		await flushPromises();
		await remove(wrapper, 'forward.example.org');
		expect(listed(wrapper)).toEqual(['lists.example.com']);

		// The inbound TLS card on the same page saves the moment it is flipped.
		settings.value = { ...settings.value, isInboundTlsRequired: false };
		await flushPromises();

		expect(listed(wrapper)).toEqual(['lists.example.com']);
		expect(saveButton(wrapper).attributes('disabled')).toBeUndefined();
	});

	it('keeps an unsaved edit when the stored list itself changes', async () => {
		const wrapper = mountCard();
		await flushPromises();
		await remove(wrapper, 'forward.example.org');

		// Another admin saves a different list.
		settings.value = { ...settings.value, trustedArcForwarders: ['other.example.net'] };
		await flushPromises();

		expect(listed(wrapper)).toEqual(['lists.example.com']);
		expect(saveButton(wrapper).attributes('disabled')).toBeUndefined();
	});

	it('follows the server while nothing is unsaved', async () => {
		const wrapper = mountCard();
		await flushPromises();

		settings.value = { ...settings.value, trustedArcForwarders: ['other.example.net'] };
		await flushPromises();

		expect(listed(wrapper)).toEqual(['other.example.net']);
		expect(saveButton(wrapper).attributes('disabled')).toBeDefined();
	});

	it('saves only the list, then is clean on the saved list and follows the server again', async () => {
		const wrapper = mountCard();
		await flushPromises();
		await remove(wrapper, 'forward.example.org');

		await saveButton(wrapper).trigger('click');
		await flushPromises();

		expect(run).toHaveBeenCalledTimes(1);
		expect(run).toHaveBeenCalledWith({ trustedArcForwarders: ['lists.example.com'] });
		expect(showToast).toHaveBeenCalledWith('Trusted forwarders saved.');
		expect(listed(wrapper)).toEqual(['lists.example.com']);
		expect(saveButton(wrapper).attributes('disabled')).toBeDefined();

		settings.value = { ...settings.value, trustedArcForwarders: ['other.example.net'] };
		await flushPromises();
		expect(listed(wrapper)).toEqual(['other.example.net']);
	});

	it('keeps the edit when the save is refused', async () => {
		run.mockResolvedValue({ ok: false });
		const wrapper = mountCard();
		await flushPromises();
		await remove(wrapper, 'forward.example.org');

		await saveButton(wrapper).trigger('click');
		await flushPromises();

		expect(showToast).not.toHaveBeenCalled();
		expect(listed(wrapper)).toEqual(['lists.example.com']);
		expect(saveButton(wrapper).attributes('disabled')).toBeUndefined();
	});

	it('toasts a cleared list as the rescue being off', async () => {
		const wrapper = mountCard();
		await flushPromises();
		await remove(wrapper, 'forward.example.org');
		await remove(wrapper, 'lists.example.com');

		await saveButton(wrapper).trigger('click');
		await flushPromises();

		expect(run).toHaveBeenCalledWith({ trustedArcForwarders: [] });
		expect(showToast).toHaveBeenCalledWith(
			'Trusted forwarders cleared — forwarded mail is no longer rescued.'
		);
	});

	it('puts the defaults in the draft on "Reset to defaults", unsaved until Save', async () => {
		const wrapper = mountCard();
		await flushPromises();

		await wrapper
			.findAll('button')
			.find((b) => b.text() === 'Reset to defaults')!
			.trigger('click');
		await flushPromises();

		expect(listed(wrapper)).toEqual([...DEFAULT_TRUSTED_ARC_FORWARDERS]);
		expect(run).not.toHaveBeenCalled();
		expect(saveButton(wrapper).attributes('disabled')).toBeUndefined();
	});

	it('does not hold a route leave with an unsaved edit (no dialog on this card)', async () => {
		const wrapper = mountCard();
		await flushPromises();
		await remove(wrapper, 'forward.example.org');

		const next = vi.fn();
		h.guard?.({ fullPath: '/elsewhere' }, {}, next);
		expect(next).not.toHaveBeenCalledWith(false);
	});
});
