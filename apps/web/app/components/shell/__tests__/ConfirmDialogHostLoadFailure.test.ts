/**
 * The host imports its dialog on the first question. When that import fails
 * (a chunk lost to a redeploy, the network gone), the question must still get
 * an answer, and the answer must be no: the caller is awaiting a destructive
 * action and must neither run it nor wait forever.
 */
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { useConfirm } from '~/composables/useConfirm';
import ConfirmDialogHost from '../ConfirmDialogHost.vue';

const imports = vi.hoisted(() => ({ attempts: 0 }));
vi.mock('@owlat/ui/components/ui/ConfirmationDialog.vue', () => {
	imports.attempts += 1;
	throw new Error('Failed to fetch dynamically imported module');
});

describe('ConfirmDialogHost when the dialog cannot be loaded', () => {
	it('answers no, renders nothing, and tries the import again for the next question', async () => {
		mount(ConfirmDialogHost, { attachTo: document.body });
		const confirm = useConfirm();

		await expect(confirm({ title: 'Delete forever?' })).resolves.toBe(false);
		await flushPromises();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		const afterFirst = imports.attempts;
		expect(afterFirst).toBeGreaterThan(0);

		await expect(confirm({ title: 'Delete forever?' })).resolves.toBe(false);
		expect(imports.attempts).toBeGreaterThan(afterFirst);
	});
});
