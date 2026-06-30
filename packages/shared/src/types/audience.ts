/**
 * Audience — a Campaign's targeting *selection* (who it sends to, before
 * eligibility filtering). A discriminated union over `kind`. See CONTEXT.md
 * "Audience".
 *
 * This is the snapshot-free selection subset shared by the campaign wizard,
 * the public count query, and the Audience resolution (module). Ids are plain
 * strings at this layer; the Convex edge (`convex/campaigns/audience.ts`)
 * narrows them to `Id<'topics'>` / `Id<'segments'>` and the *stored* segment
 * case additionally carries a send-time `frozenFilters` snapshot.
 */
export type Audience =
	| { kind: 'topic'; topicId: string }
	| { kind: 'segment'; segmentId: string };

/** The discriminant tags of an {@link Audience}. */
export type AudienceKind = Audience['kind'];
