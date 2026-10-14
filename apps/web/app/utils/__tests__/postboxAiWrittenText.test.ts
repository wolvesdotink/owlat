import { ref } from 'vue';
import { describe, expect, it } from 'vitest';
import { aiTextToHtml } from '@owlat/shared/answerMode';
import { aiWrittenTextOf, setAiWrittenText } from '../postboxAiWrittenText';

const QUOTE = '<br><br><div class="gmail_quote">On Monday Sam wrote: ready?</div>';

describe('postboxAiWrittenText', () => {
	it('tags a body whose written part is still exactly the AI text', () => {
		const body = ref(`${aiTextToHtml('Hi Sam,\n\nAttached.')}${QUOTE}`);
		setAiWrittenText(body, 'Hi Sam,\n\nAttached.');
		expect(aiWrittenTextOf(body)).toBe('Hi Sam,\n\nAttached.');
	});

	it('stops tagging once a person changes the written part, or the AI text is discarded', () => {
		const body = ref(`${aiTextToHtml('Hi Sam,\n\nAttached.')}${QUOTE}`);
		setAiWrittenText(body, 'Hi Sam,\n\nAttached.');
		expect(aiWrittenTextOf(body, `<p>Hi Sam, see the link.</p>${QUOTE}`)).toBeUndefined();
		setAiWrittenText(body, null);
		expect(aiWrittenTextOf(body)).toBeUndefined();
	});

	it('never tags a composer the AI did not write into', () => {
		expect(aiWrittenTextOf(ref('<p>Hi</p>'))).toBeUndefined();
	});
});
