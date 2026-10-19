// @vitest-environment happy-dom
/**
 * Fix (read on arrival §4.2): the dialog starts where the mail sits, for this
 * conversation; saving sends the destination, the scope and the optional why,
 * and the toast offers Undo.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import PostboxFixDialog from '../PostboxFixDialog.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, { get: () => anyPath, apply: () => anyPath });
	return { api: anyPath };
});

const applyRun = vi.fn(async (_args: unknown): Promise<unknown> => ({ ok: false }));
const showToast = vi.fn();

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useBackendOperation', () => ({ run: applyRun, isLoading: ref(false) }));
	vi.stubGlobal('useToast', () => ({ showToast }));
});

beforeEach(() => {
	applyRun.mockReset();
	showToast.mockReset();
});

const stubs = {
	UiModal: {
		props: ['open', 'title'],
		template: '<div v-if="open"><h2>{{ title }}</h2><slot /><slot name="footer" /></div>',
	},
	UiButton: { template: '<button type="button"><slot /></button>' },
	UiSegmentedControl: {
		props: ['options', 'modelValue'],
		emits: ['update:modelValue'],
		template:
			'<div><button v-for="o in options" :key="o.value" type="button" :data-scope="o.value" @click="$emit(\'update:modelValue\', o.value)">{{ o.label }}</button></div>',
	},
	UiTextarea: {
		props: ['modelValue', 'label', 'placeholder'],
		emits: ['update:modelValue'],
		template:
			'<label>{{ label }}<textarea :placeholder="placeholder" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" /></label>',
	},
};

function mountDialog(placement?: string) {
	return mount(PostboxFixDialog, {
		props: {
			target: {
				messageId: 'm1' as never,
				senderName: 'Deutsche Bahn',
				...(placement ? { placement: placement as never } : {}),
			},
		},
		global: { plugins: [createTestI18n()], stubs },
	});
}

describe('PostboxFixDialog', () => {
	it('starts where the mail sits, for this conversation', () => {
		const w = mountDialog('archived');
		const checked = w
			.findAll('input[type="radio"]')
			.find((r) => (r.element as HTMLInputElement).checked);
		expect(checked?.attributes('value')).toBe('auto_archive');
		expect(w.text()).toContain('Everything from Deutsche Bahn');
		expectFullyLocalized(w);
	});

	it('saves the destination, the sender scope and the why, then offers Undo', async () => {
		applyRun.mockResolvedValue({
			ok: true,
			result: {
				operationId: 'op1',
				archived: 0,
				resorted: 6,
				address: 'news@bahn.example',
				isNeedsReplyCleared: false,
				ruleDraftId: 'd1',
			},
		});
		const w = mountDialog('updates');
		await w.get('[data-testid="fix-destination-needs_me"]').setValue(true);
		await w.get('[data-scope="sender"]').trigger('click');
		await w.get('textarea').setValue('Delays on trips I am booked on matter to me');
		await w.get('[data-testid="fix-save"]').trigger('click');
		await flushPromises();
		expect(applyRun).toHaveBeenCalledWith({
			messageId: 'm1',
			destination: 'needs_me',
			scope: 'sender',
			reason: 'Delays on trips I am booked on matter to me',
		});
		expect(showToast).toHaveBeenCalledWith(
			'Mail from Deutsche Bahn now shows in Needs you A draft rule from your note is waiting in Rules.',
			'success',
			expect.objectContaining({ observedAction: expect.objectContaining({ label: 'Undo' }) })
		);
		expect(w.emitted('close')).toHaveLength(1);
	});

	it('says how many recent mails an auto-archive filed away', async () => {
		applyRun.mockResolvedValue({
			ok: true,
			result: {
				operationId: 'op2',
				archived: 6,
				resorted: 0,
				address: 'news@bahn.example',
				isNeedsReplyCleared: false,
				ruleDraftId: null,
			},
		});
		const w = mountDialog('updates');
		await w.get('[data-testid="fix-destination-auto_archive"]').setValue(true);
		await w.get('[data-scope="sender"]').trigger('click');
		await w.get('[data-testid="fix-save"]').trigger('click');
		await flushPromises();
		expect(applyRun).toHaveBeenCalledWith({
			messageId: 'm1',
			destination: 'auto_archive',
			scope: 'sender',
		});
		expect(showToast.mock.calls[0]![0]).toBe('Archived 6 recent mails from Deutsche Bahn');
	});

	it('closes without saving on Cancel', async () => {
		const w = mountDialog();
		const cancel = w.findAll('button').find((b) => b.text() === 'Cancel')!;
		await cancel.trigger('click');
		expect(w.emitted('close')).toHaveLength(1);
		expect(applyRun).not.toHaveBeenCalled();
	});
});
