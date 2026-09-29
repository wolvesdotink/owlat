import { v } from 'convex/values';

// Pre-send content scan validators, shared by the `contentScanResults` table
// (schema/delivery.ts) and its writer (campaigns/sendQueries.ts).

// What was scanned.
export const contentScanResourceTypeValidator = v.union(
	v.literal('campaign'),
	v.literal('transactional'),
	v.literal('attachment'),
	v.literal('media_upload')
);

// The scan verdict.
export const contentScanLevelValidator = v.union(
	v.literal('clean'), // Passed all checks
	v.literal('suspicious'), // Flagged for review
	v.literal('blocked') // Blocked from sending
);
