import { v, type Infer } from 'convex/values';
import type { ContactActivityModule } from '../types';

const schema = v.object({
	topicId: v.string(),
	topicName: v.optional(v.string()),
});

type Metadata = Infer<typeof schema>;

export const topicConfirmed: ContactActivityModule<'topic_confirmed', Metadata> = {
	literal: 'topic_confirmed',
	metadataSchema: schema,
};
