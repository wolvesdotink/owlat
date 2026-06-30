import { v, type Infer } from 'convex/values';
import type { ContactActivityModule } from '../types';

const schema = v.object({
	campaignId: v.optional(v.string()),
	transactionalEmailId: v.optional(v.string()),
	automationId: v.optional(v.string()),
	bounceType: v.optional(v.string()),
	errorMessage: v.optional(v.string()),
});

type Metadata = Infer<typeof schema>;

export const emailBounced: ContactActivityModule<'email_bounced', Metadata> = {
	literal: 'email_bounced',
	metadataSchema: schema,
};
