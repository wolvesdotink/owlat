import type { Component } from 'vue';
import type { Doc } from '@owlat/api/dataModel';
import type { Condition } from '~/composables/conditions';

export type StepKind = 'email' | 'delay' | 'condition';

export interface EmailStepConfig {
	emailTemplateId: string;
	subjectOverride?: string;
}

export interface DelayStepConfig {
	duration: number;
	unit: 'minutes' | 'hours' | 'days' | 'weeks';
}

export interface ConditionStepConfig {
	condition: Condition;
	yesBranchStepIndex: number | null;
	noBranchStepIndex: number | null;
}

export type StepConfigByKind = {
	email: EmailStepConfig;
	delay: DelayStepConfig;
	condition: ConditionStepConfig;
};

export type StepConfigOfKind<K extends StepKind> = StepConfigByKind[K];

export interface StepDisplayContext {
	emailTemplates: Doc<'emailTemplates'>[];
}

/**
 * Context handed to `validateForActivation` so a step can validate references
 * that depend on the surrounding workflow — e.g. a condition step's branch
 * targets, which are stored as array-position indices into the full step list.
 */
export interface StepActivationContext {
	/** Total number of steps in the workflow. */
	stepCount: number;
}

export interface StepEditorModule<K extends StepKind> {
	readonly kind: K;
	readonly label: string;
	readonly description: string;
	readonly color: string;
	readonly icon: string;
	createDefault(): StepConfigOfKind<K>;
	parseConfig(raw: unknown): StepConfigOfKind<K>;
	validateForActivation(config: StepConfigOfKind<K>, ctx: StepActivationContext): string | null;
	getDescription(config: StepConfigOfKind<K>, ctx: StepDisplayContext): string;
	readonly EditorComponent: Component;
}

export type StepEditorModuleMap = {
	[K in StepKind]: StepEditorModule<K>;
};
