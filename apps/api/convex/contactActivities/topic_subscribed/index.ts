import { v, type Infer } from 'convex/values';
import type { ContactActivityModule } from '../types';

const schema = v.object({
	topicId: v.string(),
	topicName: v.string(),
});

type Metadata = Infer<typeof schema>;

export const topicSubscribed: ContactActivityModule<'topic_subscribed', Metadata> = {
	literal: 'topic_subscribed',
	metadataSchema: schema,
};
