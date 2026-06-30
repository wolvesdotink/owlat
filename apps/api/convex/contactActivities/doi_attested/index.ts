import { v, type Infer } from 'convex/values';
import type { ContactActivityModule } from '../types';

const schema = v.object({
	attestSource: v.string(),
});

type Metadata = Infer<typeof schema>;

export const doiAttested: ContactActivityModule<'doi_attested', Metadata> = {
	literal: 'doi_attested',
	metadataSchema: schema,
};
