import { describe, expect, it } from 'vitest';
import { backgroundAskAnswers } from '../backgroundAskAnswers';

describe('backgroundAskAnswers', () => {
	it('sends what the person answered as theirs and a kept memory answer as memory', () => {
		const questions = [
			{ id: 'q1', answer: { value: 'Yes', source: 'memory' as const } },
			{ id: 'q2' },
			{ id: 'q3', answer: { value: 'No', source: 'memory' as const } },
		];
		expect(
			backgroundAskAnswers(questions, [
				{ questionId: 'q2', value: 'Friday' },
				{ questionId: 'q3', value: 'Yes' },
			])
		).toEqual([
			{ questionId: 'q2', value: 'Friday', source: 'user' },
			{ questionId: 'q3', value: 'Yes', source: 'user' },
			{ questionId: 'q1', value: 'Yes', source: 'memory' },
		]);
	});

	it('passes a file answer through', () => {
		const file = { source: 'semanticFile' as const, id: 'sf_1', filename: 'invoice.pdf' };
		expect(
			backgroundAskAnswers([{ id: 'q1' }], [{ questionId: 'q1', file, keepCopy: false }])
		).toEqual([{ questionId: 'q1', file, keepCopy: false, source: 'user' }]);
	});
});
