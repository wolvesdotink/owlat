import type { ContactActivityEditorModule } from '../types';

export const propertyUpdatedEditorModule: ContactActivityEditorModule<'property_updated'> = {
	literal: 'property_updated',
	displayConfig: {
		icon: 'lucide:settings',
		label: 'shared.contactActivities.propertyUpdated.label',
		color: 'text-text-secondary',
	},
	formatDescription(metadata) {
		if (!metadata) return 'shared.contactActivities.propertyUpdated.description';
		const { propertyKey, oldValue, newValue } = metadata;
		if (oldValue !== undefined && oldValue !== '') {
			return {
				key: 'shared.contactActivities.propertyUpdated.descriptionChanged',
				params: { property: propertyKey, oldValue, newValue },
			};
		}
		return {
			key: 'shared.contactActivities.propertyUpdated.descriptionSet',
			params: { property: propertyKey, newValue },
		};
	},
};
