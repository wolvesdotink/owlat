import { describe, it, expect } from 'vitest';
import { parseOpenAiModelIds } from '../modelListing';

describe('parseOpenAiModelIds', () => {
	it('parses model ids from an OpenAI-shaped /models fixture payload', () => {
		const fixture = {
			data: [
				{ id: 'anthropic/claude-opus-4-8', name: 'Claude Opus 4.8' },
				{ id: 'openai/gpt-4o', name: 'GPT-4o' },
				{ id: 'llama3.1', object: 'model' },
			],
		};
		expect(parseOpenAiModelIds(fixture)).toEqual([
			'anthropic/claude-opus-4-8',
			'openai/gpt-4o',
			'llama3.1',
		]);
	});

	it('skips off-shape entries without throwing', () => {
		const messy = {
			data: [{ id: 'openai/gpt-4o' }, { name: 'no id here' }, 'not-an-object', { id: 42 }, null],
		};
		expect(parseOpenAiModelIds(messy)).toEqual(['openai/gpt-4o']);
	});

	it('returns an empty list for a malformed body rather than throwing', () => {
		expect(parseOpenAiModelIds({})).toEqual([]);
		expect(parseOpenAiModelIds(null)).toEqual([]);
		expect(parseOpenAiModelIds({ data: 'nope' })).toEqual([]);
	});
});
