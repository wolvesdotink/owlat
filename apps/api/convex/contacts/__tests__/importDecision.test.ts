/**
 * The contact import decisions (`contacts/importDecision.ts`) for plain rows.
 * The mutation is held to them by
 * `__tests__/contactImport.characterization.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { Id } from '../../_generated/dataModel';
import {
	buildPerTopicLists,
	countAddedToTopic,
	countResolution,
	countRowProperties,
	doiAttestInput,
	emptyImportOutcome,
	noteImportError,
	noteSkippedKeys,
	rowActivity,
	rowEmail,
} from '../importDecision';

const NOW = 1_700_000_000_000;
const contactA = 'contact-a' as Id<'contacts'>;
const contactB = 'contact-b' as Id<'contacts'>;
const topic1 = 'topic-1' as Id<'topics'>;
const topic2 = 'topic-2' as Id<'topics'>;

describe('rowEmail', () => {
	it('normalises a valid address and names an invalid or empty one', () => {
		expect(rowEmail({ email: ' Ada@Example.COM ' })).toEqual({ email: 'ada@example.com' });
		expect(rowEmail({ email: 'nope' })).toEqual({ error: 'Invalid email: nope' });
		expect(rowEmail({ email: '' })).toEqual({ error: 'Invalid email: ' });
	});
});

describe('the outcome', () => {
	it('starts with the within-batch duplicates as skipped and counts resolutions', () => {
		const outcome = emptyImportOutcome(2);
		for (const action of ['created', 'updated', 'matched']) countResolution(outcome, action);
		expect(outcome).toMatchObject({ imported: 1, updated: 1, skipped: 3, failed: 0 });
	});

	it('caps the error list at fifty, summary lines included', () => {
		const outcome = emptyImportOutcome(0);
		for (let i = 0; i < 49; i++) noteImportError(outcome, `e${i}`);
		noteSkippedKeys(
			outcome,
			new Map([
				['company', 2],
				['city', 1],
			])
		);
		expect(outcome.errors).toHaveLength(50);
		expect(outcome.errors[49]).toBe(
			"Property 'company' is not registered; values dropped for 2 row(s)."
		);
	});

	it('tallies property writes and skipped keys across rows', () => {
		const outcome = emptyImportOutcome(0);
		const counts = new Map<string, number>();
		countRowProperties(outcome, { written: 2, autoRegistered: 1, skippedKeys: ['x'] }, counts);
		countRowProperties(outcome, { written: 0, autoRegistered: 0, skippedKeys: ['x', 'y'] }, counts);
		expect(outcome).toMatchObject({
			propertiesSet: 2,
			propertiesAutoRegistered: 1,
			propertiesSkipped: 3,
		});
		expect([...counts]).toEqual([
			['x', 2],
			['y', 1],
		]);
	});
});

describe('rowActivity', () => {
	it('records a created row for a new contact', () => {
		expect(rowActivity('created', { email: 'a@example.com' }, 0, contactA, NOW)).toEqual({
			literal: 'created',
			contactId: contactA,
			metadata: { source: 'import' },
			occurredAt: NOW,
		});
	});

	it('summarises property writes on an existing contact under the first non-empty key', () => {
		const row = { email: 'a@example.com', properties: { blank: '', gone: null, city: 'Graz' } };
		expect(rowActivity('updated', row, 1, contactA, NOW)).toEqual({
			literal: 'property_updated',
			contactId: contactA,
			metadata: { propertyKey: 'city', newValue: '1 value(s) updated' },
			occurredAt: NOW,
		});
		expect(rowActivity('matched', row, 0, contactA, NOW)).toBeNull();
	});
});

describe('doiAttestInput', () => {
	it('confirms through the admin attest edge, with the triggering user when given', () => {
		expect(doiAttestInput({ attestSource: 'paper form' }, NOW)).toEqual({
			to: 'confirmed',
			at: NOW,
			source: 'admin_attest',
			attestSource: 'paper form',
		});
		expect(doiAttestInput({ attestSource: 'paper form', triggeredBy: 'u1' }, NOW)).toMatchObject({
			triggeredBy: 'u1',
		});
	});
});

describe('topics', () => {
	const resolved = new Map([
		[contactA, 'a@example.com'],
		[contactB, 'b@example.com'],
	]);

	it('subscribes every contact to a single topic, and per row only the mapped ones', () => {
		expect([...buildPerTopicLists({ kind: 'single', topicId: topic1 }, resolved)]).toEqual([
			[topic1, [contactA, contactB]],
		]);
		expect(buildPerTopicLists({ kind: 'single', topicId: topic1 }, new Map()).size).toBe(0);
		expect([
			...buildPerTopicLists(
				{ kind: 'per_row', map: { 'a@example.com': [topic1, topic2], 'b@example.com': [topic2] } },
				resolved
			),
		]).toEqual([
			[topic1, [contactA]],
			[topic2, [contactA, contactB]],
		]);
	});

	it('counts subscribed and pending memberships as added', () => {
		expect(
			countAddedToTopic([
				{ ok: true, action: 'subscribed' },
				{ ok: true, action: 'pending_doi' },
				{ ok: true, action: 'already_subscribed' },
				{ ok: false },
			])
		).toBe(2);
	});
});
