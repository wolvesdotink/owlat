import { defineAsyncComponent } from 'vue';
import type { EmailStepConfig, StepDisplayContext, StepEditorModule } from '../types';

export const emailStepEditorModule: StepEditorModule<'email'> = {
	kind: 'email',
	label: 'Send Email',
	description: 'Send an email to the contact',
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
		if (!config.emailTemplateId) return 'Email step requires a template';
		return null;
	},
	getDescription(config, ctx: StepDisplayContext) {
		if (!config.emailTemplateId) return 'Select an email template';
		const template = ctx.emailTemplates.find((t) => t._id === config.emailTemplateId);
		return template?.name ?? 'Unknown Template';
	},
	EditorComponent: defineAsyncComponent(
		() => import('../../../../components/automations/steps/email/Editor.vue')
	),
};
