import type { ContactActivityEditorModule } from '../types';
import { ShieldCheckIcon } from '@coolicons/vue';

export const doiAttestedEditorModule: ContactActivityEditorModule<'doi_attested'> = {
	literal: 'doi_attested',
	displayConfig: {
		icon: ShieldCheckIcon,
		label: 'DOI Attested',
		color: 'text-success',
	},
	formatDescription(metadata) {
		if (metadata?.attestSource) {
			return `DOI attested via ${metadata.attestSource}`;
		}
		return 'DOI attested';
	},
};
