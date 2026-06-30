import { contactCreatedTriggerEditorModule } from './contact_created';
import { contactUpdatedTriggerEditorModule } from './contact_updated';
import { eventReceivedTriggerEditorModule } from './event_received';
import { topicSubscribedTriggerEditorModule } from './topic_subscribed';
import type {
	TriggerEditorModule,
	TriggerEditorModuleMap,
	TriggerKind,
} from './types';

export const TRIGGER_EDITOR_MODULES: TriggerEditorModuleMap = {
	contact_created: contactCreatedTriggerEditorModule,
	contact_updated: contactUpdatedTriggerEditorModule,
	event_received: eventReceivedTriggerEditorModule,
	topic_subscribed: topicSubscribedTriggerEditorModule,
};

export function triggerEditorModuleFor<K extends TriggerKind>(
	kind: K
): TriggerEditorModuleMap[K] {
	return TRIGGER_EDITOR_MODULES[kind];
}

export function listTriggerEditorModules(): TriggerEditorModule<TriggerKind>[] {
	return Object.values(TRIGGER_EDITOR_MODULES) as TriggerEditorModule<TriggerKind>[];
}

export type {
	ContactUpdatedTriggerConfig,
	EventReceivedTriggerConfig,
	TopicSubscribedTriggerConfig,
	TriggerConfigByKind,
	TriggerConfigOfKind,
	TriggerDisplayContext,
	TriggerEditorContext,
	TriggerEditorModule,
	TriggerEditorModuleMap,
	TriggerKind,
} from './types';
