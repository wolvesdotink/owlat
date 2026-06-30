import { describe, it, expect } from 'vitest';
import {
	CONDITION_EDITOR_MODULES,
	conditionEditorModuleFor,
	listConditionEditorModules,
} from '../index';

describe('Condition editor module registry', () => {
	it('contains exactly the three canonical kinds', () => {
		expect(Object.keys(CONDITION_EDITOR_MODULES).sort()).toEqual([
			'contact_property',
			'email_activity',
			'topic_membership',
		]);
	});

	it('every entry self-reports its own kind', () => {
		for (const [key, module] of Object.entries(CONDITION_EDITOR_MODULES)) {
			expect(module.kind).toBe(key);
		}
	});

	it('conditionEditorModuleFor narrows to the requested kind', () => {
		expect(conditionEditorModuleFor('contact_property').kind).toBe('contact_property');
		expect(conditionEditorModuleFor('email_activity').kind).toBe('email_activity');
		expect(conditionEditorModuleFor('topic_membership').kind).toBe('topic_membership');
	});

	it('listConditionEditorModules iterates the registry', () => {
		const list = listConditionEditorModules();
		expect(list).toHaveLength(3);
		expect(list.map((m) => m.kind).sort()).toEqual([
			'contact_property',
			'email_activity',
			'topic_membership',
		]);
	});

	it('every module exposes the full editor interface', () => {
		for (const module of listConditionEditorModules()) {
			expect(typeof module.label).toBe('string');
			expect(typeof module.description).toBe('string');
			expect(typeof module.createDefault).toBe('function');
			expect(typeof module.validateForSubmit).toBe('function');
			expect(typeof module.getDescription).toBe('function');
			expect(module.EditorComponent).toBeDefined();
		}
	});
});
