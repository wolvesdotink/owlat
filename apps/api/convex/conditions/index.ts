// The conditions facade callers import as `../conditions`. Implementation
// lives in `./evaluation` (per-Condition registry, parse, preload, evaluate)
// and `./segmentMatch` (the layer above it: filter normalization, the
// empty/AND/OR combine, the live-Contact scan). segmentMatch imports
// `./evaluation` directly, never this file, so the re-exports stay acyclic.
export {
	conditionTypeModuleFor,
	parseCondition,
	conditionsLookupReadsPerContact,
	conditionsLookupReadsPerBatch,
	preloadConditionsLookup,
	preloadConditionsLookupForContacts,
	evaluateOne,
} from './evaluation';

export {
	type SegmentFilters,
	type ParsedSegmentFilters,
	type SegmentCountPage,
	type SegmentMemberPage,
	parseSegmentFilters,
	makeSegmentPredicate,
	evaluateAgainstContact,
	evaluateCondition,
	evaluateSegmentCount,
	countLiveMatches,
	matchLiveContacts,
	countLiveMatchesForSegments,
	countMatchingContactsPage,
	listMatchingContactsPage,
} from './segmentMatch';

export type { Condition, ConditionKind } from './types';
