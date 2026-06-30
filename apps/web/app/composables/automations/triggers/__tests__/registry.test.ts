import { describe, it, expect } from 'vitest';
import {
	TRIGGER_EDITOR_MODULES,
	triggerEditorModuleFor,
	listTriggerEditorModules,
} from '../index';

describe('Trigger editor module registry', () => {
	it('contains exactly the four canonical trigger kinds', () => {
		expect(Object.keys(TRIGGER_EDITOR_MODULES).sort()).toEqual([
			'contact_created',
			'contact_updated',
			'event_received',
			'topic_subscribed',
		]);
	});

	it('every entry self-reports its own kind', () => {
		for (const [key, module] of Object.entries(TRIGGER_EDITOR_MODULES)) {
			expect(module.kind).toBe(key);
		}
	});

	it('triggerEditorModuleFor narrows to the requested kind', () => {
		expect(triggerEditorModuleFor('contact_created').kind).toBe('contact_created');
		expect(triggerEditorModuleFor('contact_updated').kind).toBe('contact_updated');
		expect(triggerEditorModuleFor('event_received').kind).toBe('event_received');
		expect(triggerEditorModuleFor('topic_subscribed').kind).toBe('topic_subscribed');
	});

	it('listTriggerEditorModules iterates the registry', () => {
		expect(listTriggerEditorModules().map((m) => m.kind).sort()).toEqual([
			'contact_created',
			'contact_updated',
			'event_received',
			'topic_subscribed',
		]);
	});

	it('only contact_created has requiresConfig=false', () => {
		expect(triggerEditorModuleFor('contact_created').requiresConfig).toBe(false);
		expect(triggerEditorModuleFor('contact_updated').requiresConfig).toBe(true);
		expect(triggerEditorModuleFor('event_received').requiresConfig).toBe(true);
		expect(triggerEditorModuleFor('topic_subscribed').requiresConfig).toBe(true);
	});

	it('only contact_created omits the EditorComponent', () => {
		expect(triggerEditorModuleFor('contact_created').EditorComponent).toBeNull();
		expect(triggerEditorModuleFor('contact_updated').EditorComponent).not.toBeNull();
		expect(triggerEditorModuleFor('event_received').EditorComponent).not.toBeNull();
		expect(triggerEditorModuleFor('topic_subscribed').EditorComponent).not.toBeNull();
	});
});

describe('contactCreatedTriggerEditorModule', () => {
	const module = triggerEditorModuleFor('contact_created');

	it('createDefault returns null (no config)', () => {
		expect(module.createDefault()).toBeNull();
	});

	it('validateForSubmit always passes', () => {
		expect(module.validateForSubmit(null)).toBeNull();
	});
});

describe('contactUpdatedTriggerEditorModule', () => {
	const module = triggerEditorModuleFor('contact_updated');

	it('createDefault returns empty propertyKey', () => {
		expect(module.createDefault()).toEqual({ propertyKey: '' });
	});

	it('validateForSubmit flags missing propertyKey', () => {
		expect(module.validateForSubmit({ propertyKey: '' })).toBe('Please select a property to watch');
		expect(module.validateForSubmit({ propertyKey: 'email' })).toBeNull();
	});
});

describe('eventReceivedTriggerEditorModule', () => {
	const module = triggerEditorModuleFor('event_received');

	it('createDefault returns empty eventName', () => {
		expect(module.createDefault()).toEqual({ eventName: '' });
	});

	it('validateForSubmit flags empty and whitespace-only event names', () => {
		expect(module.validateForSubmit({ eventName: '' })).toBe('Please enter an event name');
		expect(module.validateForSubmit({ eventName: '   ' })).toBe('Please enter an event name');
		expect(module.validateForSubmit({ eventName: 'user.signed_up' })).toBeNull();
	});
});

describe('topicSubscribedTriggerEditorModule', () => {
	const module = triggerEditorModuleFor('topic_subscribed');

	it('createDefault returns empty topicId', () => {
		expect(module.createDefault()).toEqual({ topicId: '' });
	});

	it('validateForSubmit flags missing topicId', () => {
		expect(module.validateForSubmit({ topicId: '' })).toBe('Please select a topic');
		expect(module.validateForSubmit({ topicId: 't1' })).toBeNull();
	});
});
