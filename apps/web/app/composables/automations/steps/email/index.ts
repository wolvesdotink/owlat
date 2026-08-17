import { defineAsyncComponent } from 'vue';
import type { EmailStepConfig, StepDisplayContext, StepEditorModule } from '../types';

export const emailStepEditorModule: StepEditorModule<'email'> = {
	kind: 'email',
	label: 'shared.automations.steps.email.label',
	description: 'shared.automations.steps.email.description',
	color: 'lime',
	icon: 'lucide:mail',
	createDefault: () => ({ emailTemplateId: '', subjectOverride: undefined }),
	parseConfig(raw): EmailStepConfig {
		const r = (raw ?? {}) as Record<string, unknown>;
		return {
			emailTemplateId: (r['emailTemplateId'] as string) ?? '',
			subjectOverride: (r['subjectOverride'] as string | undefined) || undefined,
		};
	},
	validateForActivation(config) {
		if (!config.emailTemplateId) return 'shared.automations.steps.email.templateRequired';
		return null;
	},
	getDescription(config, ctx: StepDisplayContext) {
		if (!config.emailTemplateId) return 'shared.automations.steps.email.selectTemplate';
		const template = ctx.emailTemplates.find((t) => t._id === config.emailTemplateId);
		if (!template) return 'shared.automations.steps.email.unknownTemplate';
		// The template name is member-authored data, so it travels as an
		// interpolation rather than as a key of its own.
		return { key: 'shared.automations.steps.email.templateName', params: { name: template.name } };
	},
	EditorComponent: defineAsyncComponent(
		() => import('../../../../components/automations/steps/email/Editor.vue')
	),
};
