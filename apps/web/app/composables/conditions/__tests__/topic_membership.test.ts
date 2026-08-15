import { describe, it, expect } from 'vitest';
import { computed } from 'vue';
import type { Doc } from '@owlat/api/dataModel';
import { topicMembershipEditorModule, TOPIC_OPERATORS } from '../topic_membership';
import type { ConditionEditorContext, LocalizedText } from '../types';
import { createTestI18n } from '~/__tests__/i18n';

/** The module carries catalog keys, so assertions render them in English. */
const { t } = createTestI18n().global;
const render = (text: LocalizedText) => t(text.key, text.params ?? {});

const makeCtx = (topics: Doc<'topics'>[] = []): ConditionEditorContext => ({
	contactProperties: computed(() => []),
	topics: computed(() => topics),
});

const newsletter = {
	_id: 't1' as never,
	name: 'Newsletter',
} as unknown as Doc<'topics'>;

describe('topicMembershipEditorModule', () => {
	it('createDefault returns a canonical topic_membership condition', () => {
		expect(topicMembershipEditorModule.createDefault(makeCtx())).toEqual({
			kind: 'topic_membership',
			topicId: '',
			operator: 'equals',
		});
	});

	describe('validateForSubmit', () => {
		it('flags missing topicId', () => {
			expect(
				t(
					topicMembershipEditorModule.validateForSubmit({
						kind: 'topic_membership',
						topicId: '',
						operator: 'equals',
					})!
				)
			).toBe('Please select a topic');
		});

		it('passes when topicId is set', () => {
			expect(
				topicMembershipEditorModule.validateForSubmit({
					kind: 'topic_membership',
					topicId: 't1',
					operator: 'equals',
				})
			).toBeNull();
		});
	});

	describe('getDescription', () => {
		it('returns "Select a topic" when topicId is empty', () => {
			expect(
				render(
					topicMembershipEditorModule.getDescription(
						{ kind: 'topic_membership', topicId: '', operator: 'equals' },
						makeCtx()
					)
				)
			).toBe('Select a topic');
		});

		it('uses topic name from context for equals', () => {
			expect(
				render(
					topicMembershipEditorModule.getDescription(
						{ kind: 'topic_membership', topicId: 't1' as never, operator: 'equals' },
						makeCtx([newsletter])
					)
				)
			).toBe('Is subscribed to Newsletter');
		});

		it('uses negative verb for not_equals', () => {
			expect(
				render(
					topicMembershipEditorModule.getDescription(
						{ kind: 'topic_membership', topicId: 't1' as never, operator: 'not_equals' },
						makeCtx([newsletter])
					)
				)
			).toBe('Is not subscribed to Newsletter');
		});

		it('falls back to the generic sentence for an unknown topic', () => {
			expect(
				render(
					topicMembershipEditorModule.getDescription(
						{ kind: 'topic_membership', topicId: 'gone' as never, operator: 'equals' },
						makeCtx([newsletter])
					)
				)
			).toBe('Is subscribed to topic');
		});
	});

	it('TOPIC_OPERATORS covers exactly equals and not_equals', () => {
		expect(TOPIC_OPERATORS.map((o) => o.value)).toEqual(['equals', 'not_equals']);
		expect(TOPIC_OPERATORS.map((o) => t(o.label))).toEqual(['Is in topic', 'Is not in topic']);
	});
});
