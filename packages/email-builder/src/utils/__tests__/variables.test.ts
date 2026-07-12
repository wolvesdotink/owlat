import { describe, it, expect } from 'vitest';
import {
	containsVariable,
	extractVariableName,
	extractVariableNames,
	fillPreviewVariables,
} from '../variables';

describe('containsVariable', () => {
	it('detects simple variables', () => {
		expect(containsVariable('Hi {{first_name}}')).toBe(true);
	});

	it('detects variables with fallbacks', () => {
		expect(containsVariable("Hi {{first_name|'there'}}")).toBe(true);
	});

	it('returns false for plain text and empty input', () => {
		expect(containsVariable('Hi there')).toBe(false);
		expect(containsVariable('')).toBe(false);
		expect(containsVariable(null)).toBe(false);
	});
});

describe('extractVariableName / extractVariableNames', () => {
	it('extracts the first variable name', () => {
		expect(extractVariableName('Hi {{first_name}}, {{last_name}}')).toBe('first_name');
	});

	it('extracts all variable names', () => {
		expect(extractVariableNames('Hi {{first_name}} {{last_name}}')).toEqual([
			'first_name',
			'last_name',
		]);
	});
});

describe('fillPreviewVariables', () => {
	it('substitutes user-provided values', () => {
		expect(fillPreviewVariables('Hi {{first_name}}!', { values: { first_name: 'Marcel' } })).toBe(
			'Hi Marcel!'
		);
	});

	it('prefers the user value over an inline fallback', () => {
		expect(
			fillPreviewVariables("Hi {{first_name|'there'}}!", { values: { first_name: 'Marcel' } })
		).toBe('Hi Marcel!');
	});

	it('uses the inline fallback when no value is provided', () => {
		expect(fillPreviewVariables("Hi {{nickname|'friend'}}!")).toBe('Hi friend!');
	});

	it('uses an empty inline fallback verbatim (matches send-time behavior)', () => {
		expect(fillPreviewVariables("Hi{{suffix|''}}!")).toBe('Hi!');
	});

	it('falls back to sample values for common contact fields', () => {
		expect(fillPreviewVariables('Hi {{first_name}}')).toBe('Hi Alex');
		expect(fillPreviewVariables('Hi {{firstName}}')).toBe('Hi Alex');
		expect(fillPreviewVariables('{{email}}')).toBe('alex@example.com');
		expect(fillPreviewVariables('{{company}}')).toBe('Acme Inc.');
	});

	it('falls back to the variable label when no sample exists', () => {
		expect(fillPreviewVariables('{{plan_tier}}', { labels: { plan_tier: 'Plan tier' } })).toBe(
			'Plan tier'
		);
	});

	it('humanizes unknown keys as a last resort', () => {
		expect(fillPreviewVariables('{{coupon_code}}')).toBe('Coupon code');
		expect(fillPreviewVariables('{{couponCode}}')).toBe('Coupon code');
	});

	it('treats an empty user value as unset', () => {
		expect(fillPreviewVariables('Hi {{first_name}}', { values: { first_name: '' } })).toBe(
			'Hi Alex'
		);
	});

	it('HTML-escapes substituted values when escape is set', () => {
		expect(
			fillPreviewVariables('{{first_name}}', { values: { first_name: '<b>x</b>' }, escape: true })
		).toBe('&lt;b&gt;x&lt;/b&gt;');
	});

	it('does not escape when escape is off (plain text)', () => {
		expect(fillPreviewVariables('{{first_name}}', { values: { first_name: 'a & b' } })).toBe(
			'a & b'
		);
	});

	it('leaves repeat-alias and index tokens alone', () => {
		expect(fillPreviewVariables('{{item.name}} {{$index}}')).toBe('{{item.name}} {{$index}}');
	});

	it('substitutes every occurrence', () => {
		expect(
			fillPreviewVariables('{{first_name}} {{first_name}}', { values: { first_name: 'M' } })
		).toBe('M M');
	});
});
