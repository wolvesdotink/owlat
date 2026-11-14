import { describe, expect, it } from 'vitest';
import en from '~~/i18n/locales/en.json';
import de from '~~/i18n/locales/de.json';
import {
	activeStartHold,
	startHoldGivesUpAt,
	startHoldReasonKey,
	startHoldRowMetaKey,
} from '~/utils/campaignStartHold';

const HOLD = { reason: 'delivery_on_hold', scheduledAt: 1_000, givesUpAt: 2_000 };

function lookup(catalog: unknown, key: string): unknown {
	return key
		.split('.')
		.reduce<unknown>(
			(node, part) =>
				node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
			catalog
		);
}

describe('activeStartHold', () => {
	it('is the recorded wait while the campaign is scheduled for that start', () => {
		expect(activeStartHold({ status: 'scheduled', scheduledAt: 1_000, startHold: HOLD })).toBe(
			HOLD
		);
	});

	it('is nothing once the campaign moved on or was rescheduled', () => {
		expect(activeStartHold({ status: 'sending', scheduledAt: 1_000, startHold: HOLD })).toBeNull();
		expect(
			activeStartHold({ status: 'scheduled', scheduledAt: 5_000, startHold: HOLD })
		).toBeNull();
		expect(activeStartHold({ status: 'scheduled', scheduledAt: 1_000 })).toBeNull();
	});
});

describe('start hold copy', () => {
	it.each(['delivery_on_hold', 'mail_server_not_ready', 'a_newer_reason'])(
		'words %s in English and German',
		(reason) => {
			const hold = { ...HOLD, reason };
			for (const key of [startHoldReasonKey(hold), startHoldRowMetaKey(hold)]) {
				expect(typeof lookup(en, key)).toBe('string');
				expect(typeof lookup(de, key)).toBe('string');
			}
		}
	);

	it('never says the wait gave up in the past', () => {
		expect(startHoldGivesUpAt(HOLD, 1_500)).toBe(61_500);
		expect(startHoldGivesUpAt({ ...HOLD, givesUpAt: 500_000 }, 1_500)).toBe(500_000);
	});
});
