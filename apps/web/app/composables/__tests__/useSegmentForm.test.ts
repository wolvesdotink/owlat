/**
 * `useSegmentForm` holds the segment builder's create and edit flows. An edit
 * sends every field the form shows, so an emptied description reaches the
 * backend as an empty string, which removes it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '@owlat/api/dataModel';
import type { SegmentFilters } from '../useSegmentFilters';

type Run = ReturnType<typeof vi.fn>;
let runs: { create: Run; update: Run; remove: Run; estimate: Run };

beforeEach(() => {
	// The audience estimate runs on a debounce timer; fake timers keep it from firing.
	vi.useFakeTimers();
	runs = {
		create: vi.fn(async () => ({ ok: true })),
		update: vi.fn(async () => ({ ok: true })),
		remove: vi.fn(async () => ({ ok: true })),
		estimate: vi.fn(async () => ({ ok: true, result: 0 })),
	};
	const order = [runs.create, runs.update, runs.remove, runs.estimate];
	let call = 0;
	vi.stubGlobal('useBackendOperation', () => ({ run: order[call++], isLoading: ref(false) }));
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
});

afterEach(() => {
	vi.useRealTimers();
});

const { useSegmentForm } = await import('../useSegmentForm');

const filters: SegmentFilters = {
	logic: 'AND',
	conditions: [{ kind: 'contact_property', field: 'email', operator: 'contains', value: 'acme' }],
};

const segment = {
	_id: 'sg_1' as Id<'segments'>,
	name: 'Acme',
	description: 'Everyone at Acme',
	filters,
};

describe('useSegmentForm save', () => {
	it('sends the description an edit keeps', async () => {
		const form = useSegmentForm();
		form.openEditModal(segment);
		await form.handleSave();
		expect(runs.update).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'sg_1', description: 'Everyone at Acme' })
		);
	});

	it('sends an emptied description so the backend removes it', async () => {
		const form = useSegmentForm();
		form.openEditModal(segment);
		form.segmentForm.description = '  ';
		await form.handleSave();
		expect(runs.update).toHaveBeenCalledWith(expect.objectContaining({ description: '' }));
	});

	it('creates without a description when none was entered', async () => {
		const form = useSegmentForm();
		form.openCreateModal();
		form.segmentForm.name = 'Acme';
		form.segmentForm.filters = filters;
		await form.handleSave();
		expect(runs.create).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'Acme', description: undefined })
		);
	});
});
