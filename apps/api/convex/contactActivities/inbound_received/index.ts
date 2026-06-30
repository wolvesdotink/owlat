import { v, type Infer } from 'convex/values';
import type { ContactActivityModule } from '../types';

const schema = v.object({
	emailSubject: v.optional(v.string()),
});

type Metadata = Infer<typeof schema>;

export const inboundReceived: ContactActivityModule<'inbound_received', Metadata> = {
	literal: 'inbound_received',
	metadataSchema: schema,
};
