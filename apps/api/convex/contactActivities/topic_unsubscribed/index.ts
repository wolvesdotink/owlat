import { v, type Infer } from 'convex/values';
import type { ContactActivityModule } from '../types';

const schema = v.object({
	topicId: v.string(),
	topicName: v.string(),
	reason: v.optional(v.string()),
});

type Metadata = Infer<typeof schema>;

export const topicUnsubscribed: ContactActivityModule<'topic_unsubscribed', Metadata> = {
	literal: 'topic_unsubscribed',
	metadataSchema: schema,
};
