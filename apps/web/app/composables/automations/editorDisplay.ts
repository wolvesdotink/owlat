import { triggerEditorModuleFor, type TriggerKind } from '~/composables/automations/triggers';

/**
 * How the automation builder draws a trigger: its label key, icon and accent,
 * resolved through the trigger editor module registry.
 */
export function getTriggerInfo(triggerType: string) {
	const module = triggerEditorModuleFor(triggerType as TriggerKind);
	return { label: module.label, icon: module.icon, color: module.color };
}

/** The builder's icon tile classes for a registry accent colour. */
export function getIconColorClass(color: string): string {
	switch (color) {
		case 'lime':
			return 'text-brand bg-brand/10';
		case 'lavender':
			return 'text-brand bg-brand/10';
		case 'warning':
			return 'text-warning bg-warning/10';
		case 'success':
			return 'text-success bg-success/10';
		default:
			return 'text-text-tertiary bg-bg-surface';
	}
}
