import type { ContactActivityEditorModule } from '../types';

export const propertyUpdatedEditorModule: ContactActivityEditorModule<'property_updated'> = {
	literal: 'property_updated',
	displayConfig: {
		icon: 'lucide:settings',
		label: 'Property Updated',
		color: 'text-text-secondary',
	},
	formatDescription(metadata) {
		if (!metadata) return 'Property updated';
		const { propertyKey, oldValue, newValue } = metadata;
		if (oldValue !== undefined && oldValue !== '') {
			return `Changed ${propertyKey} from "${oldValue}" to "${newValue}"`;
		}
		return `Set ${propertyKey} to "${newValue}"`;
	},
};
