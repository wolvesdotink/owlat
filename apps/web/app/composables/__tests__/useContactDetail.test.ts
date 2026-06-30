import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { diffPropertyValues, useContactDetail } from '../useContactDetail';

describe('useContactDetail.diffPropertyValues', () => {
	it('sets a property that gained a value', () => {
		const result = diffPropertyValues(['p1'], { p1: 'Acme' }, { p1: '' });
		expect(result.toSet).toEqual([{ propertyId: 'p1', value: 'Acme' }]);
		expect(result.toRemove).toEqual([]);
	});

	it('sets a property whose value changed', () => {
		const result = diffPropertyValues(['p1'], { p1: 'Globex' }, { p1: 'Acme' });
		expect(result.toSet).toEqual([{ propertyId: 'p1', value: 'Globex' }]);
		expect(result.toRemove).toEqual([]);
	});

	it('removes a property that was cleared', () => {
		const result = diffPropertyValues(['p1'], { p1: '' }, { p1: 'Acme' });
		expect(result.toSet).toEqual([]);
		expect(result.toRemove).toEqual(['p1']);
	});

	it('skips unchanged properties', () => {
		const result = diffPropertyValues(['p1', 'p2'], { p1: 'Acme', p2: 'gold' }, { p1: 'Acme', p2: 'gold' });
		expect(result.toSet).toEqual([]);
		expect(result.toRemove).toEqual([]);
	});

	it('treats whitespace-only edits as empty (no-op when already unset)', () => {
		const result = diffPropertyValues(['p1'], { p1: '   ' }, { p1: '' });
		expect(result.toSet).toEqual([]);
		expect(result.toRemove).toEqual([]);
	});

	it('trims values before sending them to the backend', () => {
		const result = diffPropertyValues(['p1'], { p1: '  Acme  ' }, { p1: '' });
		expect(result.toSet).toEqual([{ propertyId: 'p1', value: 'Acme' }]);
	});

	it('removes a property when its value is whitespace-blanked', () => {
		const result = diffPropertyValues(['p1'], { p1: '   ' }, { p1: 'Acme' });
		expect(result.toSet).toEqual([]);
		expect(result.toRemove).toEqual(['p1']);
	});

	it('handles a mix of set, remove, and unchanged in one pass', () => {
		const result = diffPropertyValues(
			['p1', 'p2', 'p3', 'p4'],
			{ p1: 'new', p2: '', p3: 'same', p4: 'changed' },
			{ p1: '', p2: 'old', p3: 'same', p4: 'before' },
		);
		expect(result.toSet).toEqual([
			{ propertyId: 'p1', value: 'new' },
			{ propertyId: 'p4', value: 'changed' },
		]);
		expect(result.toRemove).toEqual(['p2']);
	});

	it('ignores property ids that are absent from the edited form', () => {
		const result = diffPropertyValues(['p1'], {}, { p1: '' });
		expect(result.toSet).toEqual([]);
		expect(result.toRemove).toEqual([]);
	});
});

/**
 * Regression test for the void-remove bug: propertyValues.remove now returns a
 * defined value (true) so a successful clear is no longer mistaken for the
 * useBackendOperation error sentinel (undefined). Before the fix, saveChanges
 * bailed out on the first clear — leaving isEditing=true and skipping every
 * subsequent removal when more than one property was cleared.
 */
describe('useContactDetail.saveChanges (custom property clears)', () => {
	type RunMock = (args: unknown) => Promise<unknown>;

	let removeCalls: unknown[];
	let setCalls: unknown[];
	// Per-label run() implementations; success returns a defined value, error
	// returns undefined (mirrors useBackendOperation.run semantics).
	let runByLabel: Record<string, RunMock>;

	const contactRecord = {
		_id: 'c1',
		email: 'a@b.com',
		firstName: 'Ann',
		lastName: 'Lee',
		timezone: '',
		language: '',
	};

	// Two stored property values; the form clears both.
	const storedValues = [
		{ propertyId: 'p1', value: 'Acme' },
		{ propertyId: 'p2', value: 'gold' },
	];
	const propertyDefs = [{ _id: 'p1' }, { _id: 'p2' }];

	beforeEach(() => {
		removeCalls = [];
		setCalls = [];
		runByLabel = {
			'Update contact': () => Promise.resolve({ _id: 'c1' }),
			'Update contact properties': (args) => {
				setCalls.push(args);
				return Promise.resolve(['p1']);
			},
			// Successful remove resolves to a defined value (the real mutation
			// now returns true) — not undefined.
			'Clear contact property': (args) => {
				removeCalls.push(args);
				return Promise.resolve(true);
			},
			'Delete contact': () => Promise.resolve({ _id: 'c1' }),
		};

		vi.stubGlobal('useRouter', () => ({ push: vi.fn() }));
		// useContactDetail calls useConvexQuery twice in a fixed order:
		// 1) contacts.get, 2) propertyValues.listByContact. Convex function
		// references are not stringifiable, so route by call order.
		let convexQueryCall = 0;
		vi.stubGlobal('useConvexQuery', () => {
			convexQueryCall += 1;
			if (convexQueryCall === 1) {
				return { data: ref(contactRecord), isLoading: ref(false) };
			}
			return { data: ref(storedValues), isLoading: ref(false) };
		});
		vi.stubGlobal('useOrganizationQuery', () => ({ data: ref(propertyDefs) }));
		vi.stubGlobal('useBackendOperation', (_fn: unknown, options: { label: string }) => ({
			run: (args: unknown) => runByLabel[options.label]!(args),
			isLoading: ref(false),
			inlineError: ref(null),
		}));
	});

	const make = () => useContactDetail(ref('c1') as never);

	it('removes every cleared property and exits edit mode on success', async () => {
		const detail = make();
		detail.startEditing();
		// Clear both custom property values.
		detail.propertyForm.value = { p1: '', p2: '' };

		await detail.saveChanges();

		expect(removeCalls).toEqual([
			{ contactId: 'c1', propertyId: 'p1' },
			{ contactId: 'c1', propertyId: 'p2' },
		]);
		// No bulkSet needed when only clears happen.
		expect(setCalls).toHaveLength(0);
		expect(detail.isSaving.value).toBe(false);
		expect(detail.isEditing.value).toBe(false);
	});

	it('stops and stays in edit mode if a removal fails', async () => {
		runByLabel['Clear contact property'] = (args) => {
			removeCalls.push(args);
			// First clear errors -> run resolves undefined.
			return Promise.resolve(undefined);
		};

		const detail = make();
		detail.startEditing();
		detail.propertyForm.value = { p1: '', p2: '' };

		await detail.saveChanges();

		// Bailed out after the first (failing) removal; second never ran.
		expect(removeCalls).toEqual([{ contactId: 'c1', propertyId: 'p1' }]);
		expect(detail.isSaving.value).toBe(false);
		expect(detail.isEditing.value).toBe(true);
	});
});

/**
 * resendDoiConfirmation wires the orphaned `topics.resendDoiConfirmation`
 * mutation onto the contact detail page. It only fires for a contact in the
 * `pending` DOI state and forwards the contactId; the confirmation-link host
 * is resolved server-side from SITE_URL, never passed from the client.
 */
describe('useContactDetail.resendDoiConfirmation', () => {
	let resendCalls: unknown[];

	const setup = (doiStatus: string | undefined) => {
		resendCalls = [];
		vi.stubGlobal('useRouter', () => ({ push: vi.fn() }));
		vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: 'https://acme.test' } }));
		let convexQueryCall = 0;
		vi.stubGlobal('useConvexQuery', () => {
			convexQueryCall += 1;
			if (convexQueryCall === 1) {
				return {
					data: ref({ _id: 'c1', email: 'a@b.com', doiStatus }),
					isLoading: ref(false),
				};
			}
			return { data: ref([]), isLoading: ref(false) };
		});
		vi.stubGlobal('useOrganizationQuery', () => ({ data: ref([]) }));
		vi.stubGlobal('useBackendOperation', (_fn: unknown, options: { label: string }) => ({
			run: (args: unknown) => {
				if (options.label === 'Resend confirmation email') {
					resendCalls.push(args);
					return Promise.resolve({ success: true });
				}
				return Promise.resolve({ _id: 'c1' });
			},
			isLoading: ref(false),
			inlineError: ref(null),
		}));
		return useContactDetail(ref('c1') as never);
	};

	it('resends with contactId only (host resolved server-side) when pending', async () => {
		const detail = setup('pending');
		const result = await detail.resendDoiConfirmation();
		expect(resendCalls).toEqual([{ contactId: 'c1' }]);
		expect(result).toEqual({ success: true });
		expect(detail.isResendingDoi.value).toBe(false);
	});

	it('no-ops for a contact that is not pending', async () => {
		const detail = setup('confirmed');
		const result = await detail.resendDoiConfirmation();
		expect(resendCalls).toEqual([]);
		expect(result).toBeUndefined();
	});
});
