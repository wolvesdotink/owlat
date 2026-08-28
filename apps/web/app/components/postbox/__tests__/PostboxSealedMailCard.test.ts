// @vitest-environment happy-dom
/**
 * PostboxSealedMailCard — "your mail is sealed" in Preferences (plan idea 55).
 *
 * Two things are under test, and both are about not lying to the reader.
 *
 * HONESTY: an address with no sealing key must SAY so. The whole reason a member
 * comes to this card is to find out whether the lock glyphs on their mail apply
 * to them, and a card that only ever reassured would answer that question wrong.
 *
 * THE GATE: the recovery kit is the private key that opens this person's sealed
 * mail. The password is collected and sent, never checked here — the server
 * decides, and each refusal it can return gets its own honest sentence, so
 * "wrong password" and "too many tries" are never conflated. Nothing is
 * downloaded unless the server actually returned a kit.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, computed, type Ref } from 'vue';

import PostboxSealedMailCard from '../PostboxSealedMailCard.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

type StatusRow = { address: string; hasKey: boolean; fingerprint: string | null };
const statusData: Ref<{ enabled: boolean; addresses: StatusRow[] } | null> = ref(null);
const flagOn = ref(true);
const run = vi.fn(async (_args: unknown): Promise<unknown> => undefined);
const isLoading = ref(false);
const clicked = vi.fn();

beforeAll(() => {
	vi.stubGlobal('useConvexQuery', () => ({ data: statusData, isLoading: ref(false) }));
	vi.stubGlobal('useBackendOperation', () => ({ run, isLoading, inlineError: ref(null) }));
	vi.stubGlobal('useFeatureFlag', () => ({
		isEnabled: (name: string) => name === 'sealedMail' && flagOn.value,
	}));
	vi.stubGlobal('computed', computed);
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	// jsdom/happy-dom have no object URLs or real downloads; record the attempt.
	vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:kit', revokeObjectURL: () => {} });
	HTMLAnchorElement.prototype.click = clicked;
});

beforeEach(() => {
	flagOn.value = true;
	isLoading.value = false;
	clicked.mockReset();
	run.mockReset();
	statusData.value = {
		enabled: true,
		addresses: [
			{ address: 'alice@owlat.test', hasKey: true, fingerprint: 'AAAA1111BBBB2222' },
			{ address: 'sales@owlat.test', hasKey: false, fingerprint: null },
		],
	};
});

const iconStub = { props: ['name'], template: '<span />' };
const buttonStub = {
	props: ['size', 'variant', 'disabled', 'loading'],
	template: '<button v-bind="$attrs"><slot /></button>',
};
const modalStub = {
	props: ['open', 'title', 'size', 'persistent', 'closable'],
	template: '<div v-if="open"><slot /><slot name="footer" /></div>',
};

const mountCard = () =>
	mount(PostboxSealedMailCard, {
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: iconStub, UiButton: buttonStub, UiModal: modalStub },
		},
	});

/** Open the re-prompt and submit `password`. */
async function requestKit(wrapper: ReturnType<typeof mountCard>, password = 'hunter2hunter2') {
	await wrapper.find('[data-testid="sealed-mail-kit"]').trigger('click');
	await wrapper.find('[data-testid="sealed-mail-password"]').setValue(password);
	await wrapper.find('[data-testid="sealed-mail-confirm"]').trigger('click');
	await flushPromises();
}

describe('PostboxSealedMailCard', () => {
	it('says plainly which addresses have a key and which do not', () => {
		const wrapper = mountCard();
		const rows = wrapper.findAll('[data-testid="sealed-mail-address"]');
		expect(rows).toHaveLength(2);
		expect(rows[0]!.text()).toContain('alice@owlat.test');
		expect(rows[0]!.text()).toContain('This address has a sealing key.');
		expect(rows[1]!.text()).toContain('mail to and from this address is sent normally');
	});

	it('offers the recovery kit only where there is a key to recover', () => {
		const wrapper = mountCard();
		const rows = wrapper.findAll('[data-testid="sealed-mail-address"]');
		expect(rows[0]!.find('[data-testid="sealed-mail-kit"]').exists()).toBe(true);
		expect(rows[1]!.find('[data-testid="sealed-mail-kit"]').exists()).toBe(false);
	});

	it('self-hides when the instance never turned sealing on', () => {
		flagOn.value = false;
		statusData.value = { enabled: false, addresses: [] };
		expect(mountCard().find('#sealed-mail').exists()).toBe(false);
	});

	it('sends the password to the server and downloads only what comes back', async () => {
		run.mockResolvedValue({
			ok: true,
			result: {
				ok: true,
				kit: {
					address: 'alice@owlat.test',
					fingerprint: 'AAAA1111BBBB2222',
					privateKeyArmored: '-----BEGIN PGP PRIVATE KEY BLOCK-----',
					instructions: 'Keep it safe.',
					filename: 'owlat-recovery-kit-alice.asc',
					generatedAt: 1,
				},
			},
		});
		const wrapper = mountCard();
		await requestKit(wrapper);
		expect(run).toHaveBeenCalledWith({
			address: 'alice@owlat.test',
			password: 'hunter2hunter2',
		});
		expect(clicked).toHaveBeenCalledTimes(1);
		// The prompt closes on success, taking the password with it.
		expect(wrapper.find('[data-testid="sealed-mail-password"]').exists()).toBe(false);
	});

	it('downloads nothing when the server refuses, and says which refusal it was', async () => {
		const refusals: [string, string][] = [
			['bad_password', "That password didn't match. Try again."],
			['throttled', 'Too many attempts. Wait a few minutes before trying again.'],
			['not_your_address', 'You can only download a recovery kit for an address you send from.'],
			['no_key', 'This address has no sealing key to export.'],
			['feature_off', 'Sealed mail is turned off for this workspace.'],
		];
		for (const [reason, copy] of refusals) {
			run.mockResolvedValue({ ok: true, result: { ok: false, reason } });
			const wrapper = mountCard();
			await requestKit(wrapper);
			expect(wrapper.find('[data-testid="sealed-mail-refusal"]').text()).toBe(copy);
			expect(clicked).not.toHaveBeenCalled();
		}
	});

	it('clears the password on any refusal a retype cannot fix', async () => {
		run.mockResolvedValue({ ok: true, result: { ok: false, reason: 'throttled' } });
		const wrapper = mountCard();
		await requestKit(wrapper);
		expect(
			(wrapper.find('[data-testid="sealed-mail-password"]').element as HTMLInputElement).value
		).toBe('');

		// A wrong password IS worth another try, so it stays put.
		run.mockResolvedValue({ ok: true, result: { ok: false, reason: 'bad_password' } });
		const second = mountCard();
		await requestKit(second, 'nearly-right');
		expect(
			(second.find('[data-testid="sealed-mail-password"]').element as HTMLInputElement).value
		).toBe('nearly-right');
	});

	it('explains that a lost kit is lost for good, before anyone needs it', () => {
		expect(mountCard().text()).toContain('There is no master copy');
	});
});
