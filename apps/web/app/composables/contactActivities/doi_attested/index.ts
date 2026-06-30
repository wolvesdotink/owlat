import type { ContactActivityEditorModule } from '../types';

export const doiAttestedEditorModule: ContactActivityEditorModule<'doi_attested'> = {
	literal: 'doi_attested',
	displayConfig: {
		icon: 'lucide:shield-check',
		label: 'DOI Attested',
		color: 'text-green-600',
	},
	formatDescription(metadata) {
		if (metadata?.attestSource) {
			return `DOI attested via ${metadata.attestSource}`;
		}
		return 'DOI attested';
	},
};
