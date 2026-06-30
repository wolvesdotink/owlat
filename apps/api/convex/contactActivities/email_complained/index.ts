import { v, type Infer } from 'convex/values';
import type { ContactActivityModule } from '../types';

const schema = v.object({
	campaignId: v.optional(v.string()),
	transactionalEmailId: v.optional(v.string()),
	automationId: v.optional(v.string()),
});

type Metadata = Infer<typeof schema>;

export const emailComplained: ContactActivityModule<'email_complained', Metadata> = {
	literal: 'email_complained',
	metadataSchema: schema,
};
