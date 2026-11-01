/**
 * The dashboard import request (`contacts/importRequest.ts`): how the two
 * topic-assignment inputs of `contacts.importBatch` fold into the Contact
 * import (module)'s `topicAssignments`, and the return shape the dashboard
 * reads.
 */
import { describe, expect, it } from 'vitest';
import type { Id } from '../../_generated/dataModel';
import type { ImportOutcome } from '../import';
import { collapseTopicAssignments, legacyImportResult } from '../importRequest';

const topicA = 'topic_a' as Id<'topics'>;
const topicB = 'topic_b' as Id<'topics'>;
const topicC = 'topic_c' as Id<'topics'>;

describe('collapseTopicAssignments', () => {
	it('is undefined when neither input names a topic', () => {
		expect(collapseTopicAssignments({})).toBeUndefined();
		expect(collapseTopicAssignments({ contactListAssignments: [] })).toBeUndefined();
	});

	it('maps a lone topicId to a single assignment', () => {
		expect(collapseTopicAssignments({ topicId: topicA })).toEqual({
			kind: 'single',
			topicId: topicA,
		});
	});

	it('keys per-row assignments by normalized email', () => {
		expect(
			collapseTopicAssignments({
				contactListAssignments: [
					{ email: '  Ada@Example.com ', topicIds: [topicB] },
					{ email: 'grace@example.com', topicIds: [topicB, topicC] },
				],
			})
		).toEqual({
			kind: 'per_row',
			map: { 'ada@example.com': [topicB], 'grace@example.com': [topicB, topicC] },
		});
	});

	it('folds a topicId given with per-row assignments into every row, first', () => {
		expect(
			collapseTopicAssignments({
				topicId: topicA,
				contactListAssignments: [
					{ email: 'ada@example.com', topicIds: [topicB] },
					{ email: 'grace@example.com', topicIds: [] },
				],
			})
		).toEqual({
			kind: 'per_row',
			map: { 'ada@example.com': [topicA, topicB], 'grace@example.com': [topicA] },
		});
	});
});

describe('legacyImportResult', () => {
	it('reports the topic additions as addedToList and keeps the other counts', () => {
		const outcome: ImportOutcome = {
			imported: 3,
			updated: 2,
			skipped: 1,
			failed: 1,
			errors: ['row 7: invalid email'],
			addedToTopics: 4,
			propertiesSet: 5,
			propertiesAutoRegistered: 1,
			propertiesSkipped: 2,
			activitiesRecorded: 6,
		};
		expect(legacyImportResult(outcome)).toEqual({
			imported: 3,
			updated: 2,
			skipped: 1,
			failed: 1,
			errors: ['row 7: invalid email'],
			addedToList: 4,
			propertiesSet: 5,
			propertiesAutoRegistered: 1,
			propertiesSkipped: 2,
		});
	});
});
