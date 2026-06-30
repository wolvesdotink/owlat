import { v, type Infer } from 'convex/values';
import type { ContactActivityModule } from '../types';

const schema = v.object({
	campaignId: v.optional(v.string()),
	linkUrl: v.optional(v.string()),
});

type Metadata = Infer<typeof schema>;

export const emailClicked: ContactActivityModule<'email_clicked', Metadata> = {
	literal: 'email_clicked',
	metadataSchema: schema,
};
