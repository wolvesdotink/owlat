import { describe, expect, it } from 'vitest';
import { primarySendingDomain } from '../gmailBulkSender.js';

describe('primarySendingDomain', () => {
	it.each([
		['news.example.com', 'example.com'],
		['alerts.shop.example.co.uk', 'example.co.uk'],
		['EXAMPLE.COM.', 'example.com'],
	])("folds %s to Google's primary-domain counting identity", (input, expected) => {
		expect(primarySendingDomain(input)).toBe(expected);
	});

	it.each(['localhost', 'co.uk', ''])('fails closed for unclassifiable %s', (input) => {
		expect(primarySendingDomain(input)).toBeUndefined();
	});
});
