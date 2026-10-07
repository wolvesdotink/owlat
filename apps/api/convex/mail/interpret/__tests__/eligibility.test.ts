/** Which messages are interpreted (mail/interpret/eligibility.ts). */

import { describe, expect, it } from 'vitest';
import {
	isInterpretationEligible,
	isSecurityMail,
	isShortMail,
	SHORT_MAIL_MAX_CHARS,
	type InterpretEligibilitySignals,
} from '../eligibility';

const live: InterpretEligibilitySignals = {
	isLive: true,
	folder: 'inbox',
	isThreadMuted: false,
	isBulkHeaderPresent: false,
	isSenderKnown: false,
};

describe('isInterpretationEligible', () => {
	it('reads live inbox mail', () => {
		expect(isInterpretationEligible(live)).toEqual({ isEligible: true });
	});

	it('skips backfill and APPEND', () => {
		expect(isInterpretationEligible({ ...live, isLive: false })).toMatchObject({
			isEligible: false,
			skipReason: 'ineligible',
			detail: 'not_live',
		});
	});

	it('skips muted threads', () => {
		expect(isInterpretationEligible({ ...live, isThreadMuted: true })).toMatchObject({
			isEligible: false,
			detail: 'muted',
		});
	});

	it.each(['spam', 'trash', 'drafts', 'sent'])('skips inbound mail in %s', (folder) => {
		expect(isInterpretationEligible({ ...live, folder })).toMatchObject({ isEligible: false });
	});

	it('reads our own sent mail when the source is outbound', () => {
		expect(isInterpretationEligible({ ...live, folder: 'sent' }, { direction: 'outbound' })).toEqual({
			isEligible: true,
		});
	});

	it('excludes bulk mail from strangers only when all three signals agree', () => {
		const bulk = { ...live, isBulkHeaderPresent: true, category: 'newsletter' };
		expect(isInterpretationEligible(bulk)).toMatchObject({ isEligible: false, skipReason: 'bulk' });
		expect(isInterpretationEligible({ ...bulk, isSenderKnown: true })).toEqual({ isEligible: true });
		expect(isInterpretationEligible({ ...bulk, isBulkHeaderPresent: false })).toEqual({
			isEligible: true,
		});
		expect(isInterpretationEligible({ ...bulk, category: 'person' })).toEqual({ isEligible: true });
		expect(isInterpretationEligible({ ...bulk, category: 'advertising' })).toMatchObject({
			skipReason: 'bulk',
		});
	});
});

describe('short and security mail', () => {
	it('treats a short fresh part alone in its thread as short', () => {
		expect(isShortMail({ freshChars: SHORT_MAIL_MAX_CHARS, threadMessageCount: 1 })).toBe(true);
		expect(isShortMail({ freshChars: SHORT_MAIL_MAX_CHARS + 1, threadMessageCount: 1 })).toBe(false);
		expect(isShortMail({ freshChars: 20, threadMessageCount: 2 })).toBe(false);
	});

	it.each([
		['Your verification code', ''],
		['Reset your password', ''],
		['New sign-in to your account', ''],
		['Dein Bestätigungscode', ''],
		['Hello', 'Your verification code is 482913.'],
	])('recognises security mail (%s)', (subject, freshText) => {
		expect(isSecurityMail({ subject, freshText })).toBe(true);
	});

	it('leaves ordinary mail alone', () => {
		expect(
			isSecurityMail({ subject: 'Contract for Q4', freshText: 'Could you sign the contract?' })
		).toBe(false);
	});
});
