import { describe, expect, it } from 'vitest';
import { askingSentence, previewText, selectionFromQuery, stripGreeting } from '../postboxPeople';

describe('selectionFromQuery', () => {
	it('reads a person or a company page from the URL', () => {
		expect(selectionFromQuery({ person: 'lena@lumen.example' })).toEqual({
			kind: 'person',
			key: 'lena@lumen.example',
		});
		expect(selectionFromQuery({ company: 'lumen.example' })).toEqual({
			kind: 'company',
			key: 'lumen.example',
		});
		expect(selectionFromQuery({ person: '' })).toBeNull();
	});
});

describe('stripGreeting', () => {
	it('drops a salutation so the preview starts with what was said', () => {
		expect(stripGreeting('Hi again, thanks for the quick look.')).toBe(
			'Thanks for the quick look.'
		);
		expect(stripGreeting('Hallo Mara, anbei der Vertrag.')).toBe('Anbei der Vertrag.');
		expect(stripGreeting('Hey, are you still up for Saturday?')).toBe(
			'Are you still up for Saturday?'
		);
	});

	it('leaves text without a greeting, and a greeting with nothing after it, alone', () => {
		expect(stripGreeting('Your parcel is out for delivery.')).toBe(
			'Your parcel is out for delivery.'
		);
		expect(stripGreeting('Hi Lena,')).toBe('Hi Lena,');
	});
});

describe('previewText', () => {
	it('drops the greeting and the writer’s sign-off', () => {
		expect(
			previewText(
				'Hi again, thanks for the quick look. Could you send it by Friday? Best, Lena',
				'Lena'
			)
		).toBe('Thanks for the quick look. Could you send it by Friday?');
		expect(previewText('Mornings are best for our team. Lena', 'Lena')).toBe(
			'Mornings are best for our team.'
		);
		expect(previewText('Anbei der Vertrag. Viele Grüße', undefined)).toBe('Anbei der Vertrag.');
	});

	it('keeps a sentence that only ends in somebody else’s name', () => {
		expect(previewText('The intro came from Priya', 'Lena')).toBe('The intro came from Priya');
	});
});

describe('askingSentence', () => {
	it('finds the sentence that asks', () => {
		expect(
			askingSentence(
				'Hi again, thanks for the quick look. Could you send the signed copy back by Friday? Legal wants it.'
			)
		).toBe('Could you send the signed copy back by Friday?');
		expect(askingSentence('The site is live. Thanks again.')).toBeNull();
	});
});
