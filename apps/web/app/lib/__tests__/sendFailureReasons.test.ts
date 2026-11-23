/**
 * A send's error code reads as a sentence in both languages, with the fix page
 * the campaign refusals already use, and a code this build does not know falls
 * back to the generic sentence instead of a missing key.
 */
import { describe, expect, it } from 'vitest';
import en from '~~/i18n/locales/en.json';
import de from '~~/i18n/locales/de.json';
import { refusalFixLink } from '~/lib/campaignRefusal';
import {
	SEND_FAILURE_CLASSES,
	SEND_FAILURE_CODE_CLASSES,
	failureClassOfCode,
	failureClassOfSend,
	failureFixLink,
	failureLabelKey,
	failureReasonKey,
	groupFailureReasons,
} from '~/lib/sendFailureReasons';

function lookup(catalog: unknown, key: string): unknown {
	return key
		.split('.')
		.reduce<unknown>(
			(node, part) =>
				node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
			catalog
		);
}

describe('send failure copy', () => {
	it.each(SEND_FAILURE_CLASSES)('%s has a sentence and a label in English and German', (cls) => {
		for (const catalog of [en, de]) {
			expect(typeof lookup(catalog, failureReasonKey(cls))).toBe('string');
			expect(typeof lookup(catalog, failureLabelKey(cls))).toBe('string');
		}
	});

	it.each(Object.keys(SEND_FAILURE_CODE_CLASSES))('%s maps to a worded class', (code) => {
		const cls = failureClassOfCode(code);
		expect(cls).not.toBe('unknown');
		expect(typeof lookup(en, failureReasonKey(cls))).toBe('string');
		expect(typeof lookup(de, failureReasonKey(cls))).toBe('string');
	});

	it('falls back to the generic reason for a code it does not know, or none', () => {
		expect(failureClassOfCode('SOMETHING_NEW')).toBe('unknown');
		expect(failureClassOfCode('constructor')).toBe('unknown');
		expect(failureClassOfCode(undefined)).toBe('unknown');
		expect(failureClassOfCode(null)).toBe('unknown');
		expect(failureFixLink('unknown')).toBeNull();
	});

	it('reads every Mandrill reject reason as a provider refusal, except an invalid sender', () => {
		expect(failureClassOfCode('MANDRILL_REJECT_SPAM')).toBe('providerRefused');
		expect(failureClassOfCode('MANDRILL_REJECT_INVALID_SENDER')).toBe('sender');
	});
});

describe('send failure fixes', () => {
	it('sends a credentials failure to the delivery transport page', () => {
		expect(failureClassOfCode('AUTH_FAILED')).toBe('credentials');
		expect(failureFixLink('credentials')).toEqual(refusalFixLink('no_delivery_provider'));
		expect(failureFixLink('credentials')?.to).toBe('/dashboard/admin/delivery/transport');
	});

	it('offers no fix for a skip the system made on its own', () => {
		expect(failureFixLink(failureClassOfCode('RECIPIENT_SUPPRESSED'))).toBeNull();
		expect(failureFixLink(failureClassOfCode('RECIPIENT_UNSUBSCRIBED'))).toBeNull();
		expect(failureFixLink(failureClassOfCode('CONTACT_DELETED'))).toBeNull();
		expect(failureFixLink('softBounce')).toBeNull();
	});

	it('asks nobody to fix what Owlat already retried', () => {
		expect(failureFixLink(failureClassOfCode('SERVER_ERROR'))).toBeNull();
		expect(failureFixLink(failureClassOfCode('DELIVERY_DEADLINE_EXPIRED'))).toBeNull();
		expect(failureFixLink('hardBounce')).toBeNull();
	});
});

describe('send failure classes', () => {
	it('classes a bounce by its type, and a legacy one by its code', () => {
		expect(failureClassOfSend({ status: 'bounced', bounceType: 'hard' })).toBe('hardBounce');
		expect(failureClassOfSend({ status: 'bounced', bounceType: 'soft' })).toBe('softBounce');
		expect(failureClassOfSend({ status: 'bounced', errorCode: 'hard_bounce' })).toBe('hardBounce');
		expect(failureClassOfSend({ status: 'bounced' })).toBe('softBounce');
		expect(failureClassOfSend({ status: 'failed', errorCode: 'AUTH_FAILED' })).toBe('credentials');
	});

	it('folds codes with the same class into one line, largest first', () => {
		const groups = groupFailureReasons([
			{ errorCode: 'RATE_LIMIT', count: 2, exampleMessage: null },
			{ errorCode: 'AUTH_FAILED', count: 3, exampleMessage: '535 Bad credentials' },
			{ errorCode: 'SERVER_ERROR', count: 4, exampleMessage: '503 Try later' },
		]);
		expect(groups).toEqual([
			{
				failureClass: 'providerUnavailable',
				count: 6,
				errorCode: 'SERVER_ERROR',
				exampleMessage: '503 Try later',
			},
			{
				failureClass: 'credentials',
				count: 3,
				errorCode: 'AUTH_FAILED',
				exampleMessage: '535 Bad credentials',
			},
		]);
	});
});
