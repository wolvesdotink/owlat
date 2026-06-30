import { v, type Infer } from 'convex/values';
import type { ContactActivityModule } from '../types';

const schema = v.object({
	propertyKey: v.string(),
	oldValue: v.optional(v.string()),
	newValue: v.string(),
});

type Metadata = Infer<typeof schema>;

export const propertyUpdated: ContactActivityModule<'property_updated', Metadata> = {
	literal: 'property_updated',
	metadataSchema: schema,
};
