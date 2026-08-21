import { describe, it, expect } from 'vitest';
import { STEP_EDITOR_MODULES, stepEditorModuleFor, listStepEditorModules } from '../index';
import { delayUnitLabel } from '../delay';
import { conditionEditorModuleFor } from '~/composables/conditions';
import { createTestI18n } from '~/__tests__/i18n';

/**
 * Registry modules cannot call `useI18n`, so every label, error and description
 * they hand back is a message KEY (or a key plus its interpolations) that the
 * renderer translates. `resolves` asserts the catalog actually carries it: a
 * key that resolves to itself is a step whose copy would paint as a raw path.
 */
const { t, te } = createTestI18n().global;
const resolves = (key: string) => te(key) && t(key) !== key;

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
		expect(
			listStepEditorModules()
				.map((m) => m.kind)
				.sort()
		).toEqual(['condition', 'delay', 'email']);
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
		expect(module.validateForActivation({ emailTemplateId: '', subjectOverride: undefined })).toBe(
			'shared.automations.steps.email.templateRequired'
		);
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
		).toBe('shared.automations.steps.email.selectTemplate');
		expect(
			module.getDescription(
				{ emailTemplateId: 'tpl_1', subjectOverride: undefined },
				{
					emailTemplates: [
						{ _id: 'tpl_1' as never, name: 'Welcome', subject: 'Hi', status: 'active' },
					] as never,
				}
			)
		).toEqual({
			key: 'shared.automations.steps.email.templateName',
			params: { name: 'Welcome' },
		});
	});

	it('getDescription falls back to a key when the template is gone', () => {
		expect(
			module.getDescription(
				{ emailTemplateId: 'tpl_gone', subjectOverride: undefined },
				{
					emailTemplates: [],
				}
			)
		).toBe('shared.automations.steps.email.unknownTemplate');
	});

	it('every message it can hand back is in the catalog', () => {
		expect(resolves(module.label)).toBe(true);
		expect(resolves(module.description)).toBe(true);
		expect(resolves('shared.automations.steps.email.templateRequired')).toBe(true);
		expect(resolves('shared.automations.steps.email.selectTemplate')).toBe(true);
		expect(resolves('shared.automations.steps.email.unknownTemplate')).toBe(true);
		expect(t('shared.automations.steps.email.templateName', { name: 'Welcome' })).toBe('Welcome');
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
			'shared.automations.steps.delay.durationTooShort'
		);
		expect(module.validateForActivation({ duration: 1, unit: 'days' })).toBeNull();
	});

	const described = (config: {
		duration: number;
		unit: 'minutes' | 'hours' | 'days' | 'weeks';
	}) => {
		const value = module.getDescription(config, { emailTemplates: [] });
		return typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
	};

	it('getDescription pluralises correctly', () => {
		expect(described({ duration: 1, unit: 'days' })).toBe('Wait 1 day');
		expect(described({ duration: 2, unit: 'days' })).toBe('Wait 2 days');
		expect(described({ duration: 30, unit: 'minutes' })).toBe('Wait 30 minutes');
	});

	it('getDescription hands back a key plus its interpolation', () => {
		expect(module.getDescription({ duration: 2, unit: 'weeks' }, { emailTemplates: [] })).toEqual({
			key: 'shared.automations.steps.delay.wait.weeks.other',
			params: { count: 2 },
		});
	});

	it('delayUnitLabel keys the singular and plural unit words', () => {
		expect(t(delayUnitLabel(1, 'minutes'))).toBe('minute');
		expect(t(delayUnitLabel(2, 'minutes'))).toBe('minutes');
		expect(t(delayUnitLabel(1, 'hours'))).toBe('hour');
		expect(t(delayUnitLabel(1, 'weeks'))).toBe('week');
	});

	it('every message it can hand back is in the catalog', () => {
		expect(resolves(module.label)).toBe(true);
		expect(resolves(module.description)).toBe(true);
		expect(resolves('shared.automations.steps.delay.durationTooShort')).toBe(true);
		expect(resolves('shared.automations.steps.delay.configure')).toBe(true);
		for (const unit of ['minutes', 'hours', 'days', 'weeks'] as const) {
			for (const count of [1, 2]) {
				expect(resolves(delayUnitLabel(count, unit))).toBe(true);
				expect(described({ duration: count, unit })).not.toContain('shared.automations');
			}
		}
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

	// The inner condition registry owns its own copy, so the assertion is that
	// this step hands that verdict straight through — not what it happens to say.
	const innerVerdict = (condition: {
		kind: 'topic_membership';
		topicId: string;
		operator: 'equals';
	}) =>
		(
			conditionEditorModuleFor('topic_membership').validateForSubmit as unknown as (
				c: unknown
			) => unknown
		)(condition);

	it('validateForActivation delegates to the inner Condition editor module', () => {
		const invalid = { kind: 'topic_membership', topicId: '', operator: 'equals' } as const;
		expect(
			module.validateForActivation(
				{
					condition: invalid,
					yesBranchStepIndex: null,
					noBranchStepIndex: null,
				},
				{ stepCount: 3 }
			)
		).toEqual(innerVerdict(invalid));

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
		).toBe('shared.automations.steps.condition.branchTargetMissing.trueBranch');
	});

	it('validateForActivation flags an out-of-range "false" branch target', () => {
		expect(
			module.validateForActivation(
				{ condition: validInner, yesBranchStepIndex: null, noBranchStepIndex: 3 },
				{ stepCount: 3 }
			)
		).toBe('shared.automations.steps.condition.branchTargetMissing.falseBranch');
	});

	it('validateForActivation flags a negative branch target', () => {
		expect(
			module.validateForActivation(
				{ condition: validInner, yesBranchStepIndex: -1, noBranchStepIndex: null },
				{ stepCount: 3 }
			)
		).toBe('shared.automations.steps.condition.branchTargetMissing.trueBranch');
	});

	it('validateForActivation reports the inner condition error before the branch check', () => {
		const invalid = { kind: 'topic_membership', topicId: '', operator: 'equals' } as const;
		expect(
			module.validateForActivation(
				{
					condition: invalid,
					yesBranchStepIndex: 99,
					noBranchStepIndex: null,
				},
				{ stepCount: 3 }
			)
		).toEqual(innerVerdict(invalid));
	});

	it('every message it owns is in the catalog', () => {
		expect(resolves(module.label)).toBe(true);
		expect(resolves(module.description)).toBe(true);
		expect(resolves('shared.automations.steps.condition.branchTargetMissing.trueBranch')).toBe(
			true
		);
		expect(resolves('shared.automations.steps.condition.branchTargetMissing.falseBranch')).toBe(
			true
		);
	});
});
