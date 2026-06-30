import { v, type Infer } from 'convex/values';
import type { ContactActivityModule } from '../types';

const schema = v.object({
	source: v.optional(v.string()),
});

type Metadata = Infer<typeof schema>;

export const created: ContactActivityModule<'created', Metadata> = {
	literal: 'created',
	metadataSchema: schema,
};
