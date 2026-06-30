import { describe, it, expect } from 'vitest';
import {
	STEP_EDITOR_MODULES,
	stepEditorModuleFor,
	listStepEditorModules,
} from '../index';
import { delayUnitLabel } from '../delay';

describe('Step editor module registry', () => {
	it('contains exactly the three canonical step kinds', () => {
		expect(Object.keys(STEP_EDITOR_MODULES).sort()).toEqual(['condition', 'delay', 'email']);
	});

	it('every entry self-reports its own kind', () => {
		for (const [key, module] of Object.entries(STEP_EDITOR_MODULES)) {
			expect(module.kind).toBe(key);
		}
	});

	it('stepEditorModuleFor narrows to the requested kind', () => {
		expect(stepEditorModuleFor('email').kind).toBe('email');
		expect(stepEditorModuleFor('delay').kind).toBe('delay');
		expect(stepEditorModuleFor('condition').kind).toBe('condition');
	});

	it('listStepEditorModules iterates the registry', () => {
		expect(listStepEditorModules().map((m) => m.kind).sort()).toEqual([
			'condition',
			'delay',
			'email',
		]);
	});
});

describe('emailStepEditorModule', () => {
	const module = stepEditorModuleFor('email');

	it('createDefault returns an empty email step', () => {
		expect(module.createDefault()).toEqual({ emailTemplateId: '', subjectOverride: undefined });
	});

	it('parseConfig coerces missing fields', () => {
		expect(module.parseConfig({})).toEqual({ emailTemplateId: '', subjectOverride: undefined });
		expect(module.parseConfig({ emailTemplateId: 'tpl_1', subjectOverride: 'Hi' })).toEqual({
			emailTemplateId: 'tpl_1',
			subjectOverride: 'Hi',
		});
	});

	it('validateForActivation requires a template', () => {
		expect(
			module.validateForActivation({ emailTemplateId: '', subjectOverride: undefined })
		).toBe('Email step requires a template');
		expect(
			module.validateForActivation({ emailTemplateId: 'tpl_1', subjectOverride: undefined })
		).toBeNull();
	});

	it('getDescription uses the resolved template name', () => {
		expect(
			module.getDescription(
				{ emailTemplateId: '', subjectOverride: undefined },
				{ emailTemplates: [] }
			)
		).toBe('Select an email template');
		expect(
			module.getDescription(
				{ emailTemplateId: 'tpl_1', subjectOverride: undefined },
				{
					emailTemplates: [
						{ _id: 'tpl_1' as never, name: 'Welcome', subject: 'Hi', status: 'active' },
					] as never,
				}
			)
		).toBe('Welcome');
	});
});

describe('delayStepEditorModule', () => {
	const module = stepEditorModuleFor('delay');

	it('createDefault returns 1 day', () => {
		expect(module.createDefault()).toEqual({ duration: 1, unit: 'days' });
	});

	it('parseConfig falls back to safe defaults', () => {
		expect(module.parseConfig({})).toEqual({ duration: 1, unit: 'days' });
		expect(module.parseConfig({ duration: 7, unit: 'days' })).toEqual({
			duration: 7,
			unit: 'days',
		});
	});

	it('validateForActivation requires a positive duration', () => {
		expect(module.validateForActivation({ duration: 0, unit: 'days' })).toBe(
			'Delay duration must be at least 1'
		);
		expect(module.validateForActivation({ duration: 1, unit: 'days' })).toBeNull();
	});

	it('getDescription pluralises correctly', () => {
		expect(
			module.getDescription({ duration: 1, unit: 'days' }, { emailTemplates: [] })
		).toBe('Wait 1 day');
		expect(
			module.getDescription({ duration: 2, unit: 'days' }, { emailTemplates: [] })
		).toBe('Wait 2 days');
		expect(
			module.getDescription({ duration: 30, unit: 'minutes' }, { emailTemplates: [] })
		).toBe('Wait 30 minutes');
	});

	it('delayUnitLabel pluralises across units', () => {
		expect(delayUnitLabel(1, 'minutes')).toBe('minute');
		expect(delayUnitLabel(2, 'minutes')).toBe('minutes');
		expect(delayUnitLabel(1, 'hours')).toBe('hour');
		expect(delayUnitLabel(1, 'weeks')).toBe('week');
	});
});

describe('conditionStepEditorModule', () => {
	const module = stepEditorModuleFor('condition');

	it('createDefault wraps a canonical Condition with null branch indices', () => {
		expect(module.createDefault()).toEqual({
			condition: {
				kind: 'contact_property',
				field: '',
				operator: 'equals',
				value: '',
			},
			yesBranchStepIndex: null,
			noBranchStepIndex: null,
		});
	});

	it('parseConfig preserves the persisted shape', () => {
		expect(
			module.parseConfig({
				condition: { kind: 'topic_membership', topicId: 't1', operator: 'equals' },
				yesBranchStepIndex: 3,
				noBranchStepIndex: null,
			})
		).toEqual({
			condition: { kind: 'topic_membership', topicId: 't1', operator: 'equals' },
			yesBranchStepIndex: 3,
			noBranchStepIndex: null,
		});
	});

	it('validateForActivation delegates to the inner Condition editor module', () => {
		expect(
			module.validateForActivation(
				{
					condition: { kind: 'topic_membership', topicId: '', operator: 'equals' },
					yesBranchStepIndex: null,
					noBranchStepIndex: null,
				},
				{ stepCount: 3 }
			)
		).toBe('Please select a topic');

		expect(
			module.validateForActivation(
				{
					condition: { kind: 'topic_membership', topicId: 't1' as never, operator: 'equals' },
					yesBranchStepIndex: null,
					noBranchStepIndex: null,
				},
				{ stepCount: 3 }
			)
		).toBeNull();
	});

	const validInner = {
		kind: 'topic_membership' as const,
		topicId: 't1' as never,
		operator: 'equals' as const,
	};

	it('validateForActivation accepts in-range branch targets', () => {
		expect(
			module.validateForActivation(
				{ condition: validInner, yesBranchStepIndex: 0, noBranchStepIndex: 2 },
				{ stepCount: 3 }
			)
		).toBeNull();
	});

	it('validateForActivation flags an out-of-range "true" branch target', () => {
		expect(
			module.validateForActivation(
				{ condition: validInner, yesBranchStepIndex: 5, noBranchStepIndex: null },
				{ stepCount: 3 }
			)
		).toBe(
			'Condition "true" branch points at a step that no longer exists — pick a valid branch target'
		);
	});

	it('validateForActivation flags an out-of-range "false" branch target', () => {
		expect(
			module.validateForActivation(
				{ condition: validInner, yesBranchStepIndex: null, noBranchStepIndex: 3 },
				{ stepCount: 3 }
			)
		).toBe(
			'Condition "false" branch points at a step that no longer exists — pick a valid branch target'
		);
	});

	it('validateForActivation flags a negative branch target', () => {
		expect(
			module.validateForActivation(
				{ condition: validInner, yesBranchStepIndex: -1, noBranchStepIndex: null },
				{ stepCount: 3 }
			)
		).toBe(
			'Condition "true" branch points at a step that no longer exists — pick a valid branch target'
		);
	});

	it('validateForActivation reports the inner condition error before the branch check', () => {
		expect(
			module.validateForActivation(
				{
					condition: { kind: 'topic_membership', topicId: '', operator: 'equals' },
					yesBranchStepIndex: 99,
					noBranchStepIndex: null,
				},
				{ stepCount: 3 }
			)
		).toBe('Please select a topic');
	});
});
