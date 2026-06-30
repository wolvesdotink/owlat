import { describe, it, expect } from 'vitest';
import { buildFeedbackId } from '../feedbackId';

const FEEDBACK_ID_RE = /^[^:]+:[^:]+:[^:]+:[^:]+$/;

// Split a (non-null) Feedback-ID into its four fields, indexable safely.
function fieldsOf(value: string | null): [string, string, string, string] {
	expect(value).not.toBeNull();
	const parts = value!.split(':');
	expect(parts).toHaveLength(4);
	return [parts[0] ?? '', parts[1] ?? '', parts[2] ?? '', parts[3] ?? ''];
}

describe('buildFeedbackId', () => {
	it('builds the Gmail four-field shape `a:b:c:SenderId`', () => {
		const value = buildFeedbackId({
			streamType: 'campaign',
			organizationId: 'org_1',
			campaignId: 'camp_1',
			audienceType: 'topic',
		});
		expect(value).toMatch(FEEDBACK_ID_RE);
		expect(value!.split(':')).toEqual(['campaign', 'camp_1', 'topic', expect.any(String)]);
	});

	it('returns null when there is no organizationId anchor (empty SenderId → no FBL data)', () => {
		expect(
			buildFeedbackId({ streamType: 'campaign', organizationId: '', campaignId: 'c' }),
		).toBeNull();
	});

	it('SenderId is deterministic for the same organization', () => {
		const a = buildFeedbackId({ streamType: 'txn', organizationId: 'org_stable' });
		const b = buildFeedbackId({ streamType: 'txn', organizationId: 'org_stable' });
		expect(a).toBe(b);
	});

	it('SenderId differs across organizations', () => {
		const a = fieldsOf(buildFeedbackId({ streamType: 'txn', organizationId: 'org_a' }))[3];
		const b = fieldsOf(buildFeedbackId({ streamType: 'txn', organizationId: 'org_b' }))[3];
		expect(a).not.toBe(b);
	});

	it('SenderId stays in Gmail 5–15 char range', () => {
		for (const org of ['x', 'org_1', 'a_very_long_organization_identifier_value_here']) {
			const sender = fieldsOf(buildFeedbackId({ streamType: 'campaign', organizationId: org }))[3];
			expect(sender.length).toBeGreaterThanOrEqual(5);
			expect(sender.length).toBeLessThanOrEqual(15);
		}
	});

	it('the stream token distinguishes campaign vs txn', () => {
		expect(fieldsOf(buildFeedbackId({ streamType: 'campaign', organizationId: 'o' }))[0]).toBe(
			'campaign',
		);
		expect(fieldsOf(buildFeedbackId({ streamType: 'txn', organizationId: 'o' }))[0]).toBe('txn');
	});

	it('strips colons from sender-supplied identifier fields (delimiter safety)', () => {
		const fields = fieldsOf(
			buildFeedbackId({
				streamType: 'campaign',
				organizationId: 'o',
				campaignId: 'a:b:c',
			}),
		);
		// 4 fields total — the embedded colons must not break the structure.
		expect(fields[1]).toBe('abc');
	});

	it('caps the whole value at 127 bytes, preserving the SenderId anchor', () => {
		const value = buildFeedbackId({
			streamType: 'campaign',
			organizationId: 'o',
			campaignId: 'C'.repeat(500),
		});
		expect(new TextEncoder().encode(value!).length).toBeLessThanOrEqual(127);
		expect(fieldsOf(value)[3].length).toBeGreaterThanOrEqual(5);
	});
});
