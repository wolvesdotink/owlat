import { describe, it, expect } from 'vitest';
import {
	CUSTOM_SENDER_VALUE,
	buildSenderOptions,
	defaultSenderValue,
	formatSenderLabel,
	isCustomSender,
	isSenderSelectionComplete,
	type PickerSender,
} from '../campaignSenderPicker';

const news: PickerSender = { _id: 's1', email: 'news@acme.com', displayName: 'Acme News' };
const support: PickerSender = { _id: 's2', email: 'support@acme.com' };
const primary: PickerSender = {
	_id: 's3',
	email: 'primary@acme.com',
	displayName: 'Primary',
	isDefault: true,
};

describe('formatSenderLabel', () => {
	it('renders "Name <address>" when a display name is present', () => {
		expect(formatSenderLabel(news)).toBe('Acme News <news@acme.com>');
	});

	it('falls back to the bare address when there is no display name', () => {
		expect(formatSenderLabel(support)).toBe('support@acme.com');
	});

	it('treats a whitespace-only display name as absent', () => {
		expect(formatSenderLabel({ _id: 'x', email: 'a@acme.com', displayName: '   ' })).toBe(
			'a@acme.com'
		);
	});
});

describe('buildSenderOptions — custom visibility per toggle', () => {
	it('maps one option per sender, no custom option when the toggle is off', () => {
		const options = buildSenderOptions([news, support], false);
		expect(options).toEqual([
			{ value: 's1', label: 'Acme News <news@acme.com>' },
			{ value: 's2', label: 'support@acme.com' },
		]);
		expect(options.some((o) => o.value === CUSTOM_SENDER_VALUE)).toBe(false);
	});

	it('appends the custom option ONLY when the toggle is on', () => {
		const options = buildSenderOptions([news], true);
		expect(options).toHaveLength(2);
		const last = options[options.length - 1];
		expect(last).toEqual({ value: CUSTOM_SENDER_VALUE, label: 'Custom address…' });
	});

	it('with no curated senders, offers just the custom option when allowed', () => {
		expect(buildSenderOptions([], true)).toEqual([
			{ value: CUSTOM_SENDER_VALUE, label: 'Custom address…' },
		]);
	});

	it('with no curated senders and toggle off, offers nothing', () => {
		expect(buildSenderOptions([], false)).toEqual([]);
	});
});

describe('defaultSenderValue', () => {
	it('preselects the marked default sender', () => {
		expect(defaultSenderValue([news, primary, support], false)).toBe('s3');
	});

	it('falls back to the first sender when none is marked default', () => {
		expect(defaultSenderValue([news, support], false)).toBe('s1');
	});

	it('selects the custom option when no senders exist but custom is allowed', () => {
		expect(defaultSenderValue([], true)).toBe(CUSTOM_SENDER_VALUE);
	});

	it('selects nothing when there are no senders and custom is not allowed', () => {
		expect(defaultSenderValue([], false)).toBe('');
	});
});

describe('isCustomSender', () => {
	it('is true only for the custom sentinel', () => {
		expect(isCustomSender(CUSTOM_SENDER_VALUE)).toBe(true);
		expect(isCustomSender('s1')).toBe(false);
		expect(isCustomSender('')).toBe(false);
	});
});

describe('isSenderSelectionComplete — submit guard', () => {
	it('is false when nothing is selected', () => {
		expect(isSenderSelectionComplete('', { fromName: '', fromEmail: '' })).toBe(false);
	});

	it('is true for any curated selection regardless of the custom fields', () => {
		expect(isSenderSelectionComplete('s1', { fromName: '', fromEmail: '' })).toBe(true);
	});

	it('requires a from name AND a valid address in the custom branch', () => {
		expect(
			isSenderSelectionComplete(CUSTOM_SENDER_VALUE, { fromName: '', fromEmail: 'a@acme.com' })
		).toBe(false);
		expect(
			isSenderSelectionComplete(CUSTOM_SENDER_VALUE, { fromName: 'Me', fromEmail: 'not-an-email' })
		).toBe(false);
		expect(
			isSenderSelectionComplete(CUSTOM_SENDER_VALUE, { fromName: 'Me', fromEmail: 'me@acme.com' })
		).toBe(true);
	});

	it('trims custom fields before checking', () => {
		expect(
			isSenderSelectionComplete(CUSTOM_SENDER_VALUE, {
				fromName: '  Me  ',
				fromEmail: '  me@acme.com  ',
			})
		).toBe(true);
	});
});
