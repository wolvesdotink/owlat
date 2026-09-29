import { v } from 'convex/values';

// Autonomy validators shared by schema/autonomy.ts and the functions that
// read or write those tables.

// Provenance of an `autonomyFeedback` row: 'human' is a reviewer decision,
// 'outcome' a real-world post-send outcome captured by agent/outcomeFeedback.
export const autonomyFeedbackSourceValidator = v.union(v.literal('human'), v.literal('outcome'));
