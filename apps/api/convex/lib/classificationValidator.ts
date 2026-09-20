/**
 * The classifier's persisted verdict (`inboundMessages.classification`, also
 * spread into `agentActions`). Split out of `lib/convexValidators.ts` to keep
 * that module under the ~500 LOC file-size ratchet; re-exported from there so
 * every existing import path still resolves. See ADR-0061 for the fields the
 * response-disposition rework added.
 */

import { v } from 'convex/values';

export const classificationValidator = v.object({
	category: v.string(),
	priority: v.string(),
	sentiment: v.string(),
	intent: v.string(),
	confidence: v.number(),
	// Does the sender expect a reply from us? `false` + enough confidence is
	// what parks a message in `informational` instead of drafting. Absent on
	// rows classified before the field existed (read as "needs a response").
	needsResponse: v.optional(v.boolean()),
	// What kind of mail this is, orthogonal to the topic `category`:
	// personal | update | notification | receipt | newsletter | advertising.
	// Bulk kinds (the last four) never need a reply and get their own tab on
	// the Updates dashboard. Absent on rows classified before the field existed.
	kind: v.optional(v.string()),
	// ISO 639-1 code of the language the sender wrote in ("de", "pt-br"). The
	// draft step writes the reply in this language. Absent when undetected.
	language: v.optional(v.string()),
	// How much the recipient needs to know about this, 0–1. Ranks the Updates
	// dashboard; never gates a send.
	importance: v.optional(v.number()),
	// One-sentence summary per interface locale (`APP_LOCALES`), rendered in
	// the reader's own language on the Updates dashboard and review surfaces.
	summary: v.optional(v.record(v.string(), v.string())),
});
