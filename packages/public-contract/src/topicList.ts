/**
 * The items of `GET /api/v1/topics`. Plain TypeScript with no imports,
 * re-exported by `types.ts`; see there for why.
 */

/** A topic contacts can be subscribed to, with the fields a caller picks one by. */
export interface Topic {
	/** The topic ID the membership routes take as `{topicId}`. */
	id: string;
	name: string;
	/** What the topic is about, or `null` when it has no description. */
	description: string | null;
	/**
	 * Whether the topic requires double opt-in: a contact whose subscription
	 * is pending double opt-in counts as subscribed once they confirm their
	 * address. The add call's `doiStatus` reports the contact's confirmation
	 * state.
	 */
	requiresDoubleOptIn: boolean;
	/** ISO 8601 timestamp of when the topic was created. */
	createdAt: string;
}
