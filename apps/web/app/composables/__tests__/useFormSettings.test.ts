import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { useFormSettings } from '../useFormSettings';

/**
 * Regression test for the form-field-builder wiring (MISSING_FEATURES gap:
 * "Form builder UI cannot configure form fields"). Before this, addForm/editForm
 * never carried a `fields` list, so create() always fell back to its single
 * {email} default and update() never altered fields. These tests prove the
 * field editor mutates the list and that the add/save handlers pass the
 * configured fields to the create/update mutations.
 */
describe('useFormSettings field editor', () => {
	let createCalls: Array<Record<string, unknown>>;
	let updateCalls: Array<Record<string, unknown>>;

	beforeEach(() => {
		createCalls = [];
		updateCalls = [];

		vi.stubGlobal('useOrganizationContext', () => ({
			isLoading: ref(false),
			hasActiveOrganization: ref(true),
		}));
		vi.stubGlobal('useOrganizationQuery', () => ({
			data: ref([]),
			isLoading: ref(false),
		}));
		vi.stubGlobal('useTopicsList', () => ({ results: ref([]) }));
		vi.stubGlobal('useRuntimeConfig', () => ({
			public: { convexSiteUrl: 'https://x.test', convexUrl: 'https://x.test' },
		}));
		vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
		vi.stubGlobal('formatDate', (ts: number) => String(ts));
		vi.stubGlobal('useCopyToClipboard', () => ({
			copy: vi.fn().mockResolvedValue(true),
			copiedKey: ref(null),
		}));
		vi.stubGlobal('useBackendOperation', (_fn: unknown, options: { label: string }) => ({
			run: (args: Record<string, unknown>) => {
				if (options.label === 'Create form endpoint') {
					createCalls.push(args);
					return Promise.resolve('form1');
				}
				if (options.label === 'Update form endpoint') {
					updateCalls.push(args);
					return Promise.resolve('form1');
				}
				return Promise.resolve('ok');
			},
			isLoading: ref(false),
			inlineError: ref(null),
		}));
	});

	it('seeds the add form with a single required email field', () => {
		const s = useFormSettings();
		expect(s.addForm.fields).toEqual([
			{ key: 'email', label: 'Email', type: 'email', required: true },
		]);
	});

	it('add/remove/move helpers mutate the field list in place', () => {
		const s = useFormSettings();
		s.addFieldEditor.addField();
		expect(s.addForm.fields).toHaveLength(2);
		s.addForm.fields[1]!.key = 'firstName';
		s.addForm.fields[1]!.label = 'First name';

		// Move the new field up to the front.
		s.addFieldEditor.moveField(1, -1);
		expect(s.addForm.fields[0]!.key).toBe('firstName');

		// Moving past the edges is a no-op.
		s.addFieldEditor.moveField(0, -1);
		expect(s.addForm.fields[0]!.key).toBe('firstName');

		s.addFieldEditor.removeField(0);
		expect(s.addForm.fields).toHaveLength(1);
		expect(s.addForm.fields[0]!.key).toBe('email');
	});

	it('handleAddForm passes the configured fields to create()', async () => {
		const s = useFormSettings();
		s.addForm.name = 'Newsletter';
		s.addFieldEditor.addField();
		s.addForm.fields[1]!.key = 'firstName';
		s.addForm.fields[1]!.label = 'First name';
		s.addForm.fields[1]!.type = 'text';

		await s.handleAddForm();

		expect(createCalls).toHaveLength(1);
		expect(createCalls[0]!.fields).toEqual([
			{ key: 'email', label: 'Email', type: 'email', required: true },
			{ key: 'firstName', label: 'First name', type: 'text', required: false },
		]);
	});

	it('rejects a blank field key/label without calling create()', async () => {
		const s = useFormSettings();
		s.addForm.name = 'Newsletter';
		s.addFieldEditor.addField(); // blank key + label

		await s.handleAddForm();

		expect(createCalls).toHaveLength(0);
		expect(s.addFormErrors.fields).toBeTruthy();
	});

	it('rejects duplicate field keys without calling create()', async () => {
		const s = useFormSettings();
		s.addForm.name = 'Newsletter';
		s.addFieldEditor.addField();
		s.addForm.fields[1]!.key = 'email';
		s.addForm.fields[1]!.label = 'Dupe';

		await s.handleAddForm();

		expect(createCalls).toHaveLength(0);
		expect(s.addFormErrors.fields).toContain('email');
	});

	it('rejects removing the email field via add-form save', async () => {
		const s = useFormSettings();
		s.addForm.name = 'Newsletter';
		// Replace the seeded email field with a text-only field, then add a
		// second text field — mirrors a user deleting the email row in the UI.
		s.addForm.fields[0]!.key = 'firstName';
		s.addForm.fields[0]!.label = 'First name';
		s.addForm.fields[0]!.type = 'text';
		s.addFieldEditor.addField();
		s.addForm.fields[1]!.key = 'lastName';
		s.addForm.fields[1]!.label = 'Last name';
		s.addForm.fields[1]!.type = 'text';

		await s.handleAddForm();

		expect(createCalls).toHaveLength(0);
		expect(s.addFormErrors.fields).toMatch(/email/i);
	});

	it('rejects an edit that drops the email field', async () => {
		const s = useFormSettings();
		s.openEditModal({
			_id: 'form1',
			name: 'Signup',
			fields: [
				{ key: 'email', label: 'Email', type: 'email' as const, required: true },
				{ key: 'firstName', label: 'First name', type: 'text' as const, required: false },
			],
			isActive: true,
		} as never);
		// Delete the email field (index 0); a second field remains, so the UI
		// remove button would have been enabled.
		s.editFieldEditor.removeField(0);

		await s.handleSaveEdit();

		expect(updateCalls).toHaveLength(0);
		expect(s.editFormErrors.fields).toMatch(/email/i);
	});

	it('openEditModal loads the form fields without mutating the source', () => {
		const s = useFormSettings();
		const source = {
			_id: 'form1',
			name: 'Signup',
			fields: [
				{ key: 'email', label: 'Email', type: 'email' as const, required: true },
				{ key: 'lastName', label: 'Last name', type: 'text' as const, required: false },
			],
			isActive: true,
		};
		s.openEditModal(source as never);

		expect(s.editForm.fields).toHaveLength(2);
		// Editing the loaded copy must not touch the live query result.
		s.editForm.fields[0]!.label = 'Changed';
		expect(source.fields[0]!.label).toBe('Email');
	});

	it('handleSaveEdit passes the edited fields to update()', async () => {
		const s = useFormSettings();
		s.openEditModal({
			_id: 'form1',
			name: 'Signup',
			fields: [{ key: 'email', label: 'Email', type: 'email' as const, required: true }],
			isActive: true,
		} as never);
		s.editFieldEditor.addField();
		s.editForm.fields[1]!.key = 'consent';
		s.editForm.fields[1]!.label = 'I agree';
		s.editForm.fields[1]!.type = 'checkbox';
		s.editForm.fields[1]!.required = true;

		await s.handleSaveEdit();

		expect(updateCalls).toHaveLength(1);
		expect(updateCalls[0]!.fields).toEqual([
			{ key: 'email', label: 'Email', type: 'email', required: true },
			{ key: 'consent', label: 'I agree', type: 'checkbox', required: true },
		]);
	});
});
