import { describe, it, expect } from 'vitest';
import { MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import {
	attachmentMeter,
	ATTACHMENT_TOTAL_BUDGET_BYTES,
	ATTACHMENT_METER_SHOW_RATIO,
	ATTACHMENT_METER_AMBER_RATIO,
} from '../postboxAttachmentMeter';

const MB = 1024 * 1024;

describe('attachmentMeter', () => {
	it('draws the meter against the shared per-message wire cap', () => {
		expect(ATTACHMENT_TOTAL_BUDGET_BYTES).toBe(MAX_ATTACHMENT_BYTES);
	});

	it('is hidden below the show threshold (~50% of budget)', () => {
		const justUnder = ATTACHMENT_TOTAL_BUDGET_BYTES * ATTACHMENT_METER_SHOW_RATIO;
		const m = attachmentMeter(justUnder);
		expect(m.visible).toBe(false);
		expect(m.amber).toBe(false);
		expect(m.over).toBe(false);
	});

	it('becomes visible once past the show threshold', () => {
		const justOver = ATTACHMENT_TOTAL_BUDGET_BYTES * ATTACHMENT_METER_SHOW_RATIO + 1;
		expect(attachmentMeter(justOver).visible).toBe(true);
	});

	it('turns amber at/above the near-cap threshold', () => {
		const belowAmber = ATTACHMENT_TOTAL_BUDGET_BYTES * (ATTACHMENT_METER_AMBER_RATIO - 0.01);
		const atAmber = ATTACHMENT_TOTAL_BUDGET_BYTES * ATTACHMENT_METER_AMBER_RATIO;
		expect(attachmentMeter(belowAmber).amber).toBe(false);
		expect(attachmentMeter(atAmber).amber).toBe(true);
	});

	it('flags over-budget totals and reports a ratio above 1', () => {
		const m = attachmentMeter(ATTACHMENT_TOTAL_BUDGET_BYTES + MB);
		expect(m.over).toBe(true);
		expect(m.amber).toBe(true);
		expect(m.ratio).toBeGreaterThan(1);
	});

	it('computes ratio and echoes the totals', () => {
		const m = attachmentMeter(14 * MB, 25 * MB);
		expect(m.totalBytes).toBe(14 * MB);
		expect(m.budgetBytes).toBe(25 * MB);
		expect(m.ratio).toBeCloseTo(14 / 25, 5);
		expect(m.visible).toBe(true);
	});

	it('clamps negative totals and tolerates a zero budget without dividing by 0', () => {
		expect(attachmentMeter(-5).totalBytes).toBe(0);
		const z = attachmentMeter(10 * MB, 0);
		expect(z.visible).toBe(false);
		expect(z.amber).toBe(false);
		expect(z.ratio).toBe(0);
	});
});
