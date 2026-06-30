import { v, type Infer } from 'convex/values';
import type { ContactActivityModule } from '../types';

const schema = v.object({
	emailSubject: v.optional(v.string()),
});

type Metadata = Infer<typeof schema>;

export const inboundReplied: ContactActivityModule<'inbound_replied', Metadata> = {
	literal: 'inbound_replied',
	metadataSchema: schema,
};
