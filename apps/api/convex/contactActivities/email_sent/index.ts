import { v, type Infer } from 'convex/values';
import type { ContactActivityModule } from '../types';

const schema = v.object({
	campaignId: v.optional(v.string()),
	// transactionalEmailId is set for kind='transactional'; automation/agent
	// sends carry `automationId` instead (or no provenance id for agent replies).
	transactionalEmailId: v.optional(v.string()),
	automationId: v.optional(v.string()),
	emailSubject: v.optional(v.string()),
	// 'campaign' | 'transactional' | 'automation' | 'agent_reply'. Loose string
	// (not a literal union) so widening the non-campaign sources never breaks an
	// exhaustive reader — the web-side reads only test specific values.
	emailType: v.optional(v.string()),
});

type Metadata = Infer<typeof schema>;

export const emailSent: ContactActivityModule<'email_sent', Metadata> = {
	literal: 'email_sent',
	metadataSchema: schema,
};
