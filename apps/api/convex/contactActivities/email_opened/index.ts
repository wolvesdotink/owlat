import { v, type Infer } from 'convex/values';
import type { ContactActivityModule } from '../types';

const schema = v.object({
	campaignId: v.optional(v.string()),
	emailSubject: v.optional(v.string()),
});

type Metadata = Infer<typeof schema>;

export const emailOpened: ContactActivityModule<'email_opened', Metadata> = {
	literal: 'email_opened',
	metadataSchema: schema,
};
