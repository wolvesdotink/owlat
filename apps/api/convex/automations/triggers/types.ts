import type { Id } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import type { CoreTriggerKind } from './catalog';

// The core trigger-kind union lives once, in `catalog.ts` (`CORE_TRIGGER_KINDS`),
// which also derives the persisted-kind validator and the open plugin union from
// it. Re-export it here as `TriggerKind` so the core module registry and its
// `FireInputFor` map stay coupled to that single list (mirrors `CoreStepKind`).
export type TriggerKind = CoreTriggerKind;

export type TriggerData = Record<string, string | number | boolean | null>;

export type ContactCreatedFireInput = { contactId: Id<'contacts'> };
export type ContactUpdatedFireInput = {
	contactId: Id<'contacts'>;
	changedProperties: string[];
};
export type EventReceivedFireInput = {
	contactId: Id<'contacts'>;
	eventName: string;
	eventProperties?: string;
};
export type TopicSubscribedFireInput = {
	contactId: Id<'contacts'>;
	topicId: Id<'topics'>;
};

export type FireInputFor<T extends TriggerKind> = T extends 'contact_created'
	? ContactCreatedFireInput
	: T extends 'contact_updated'
		? ContactUpdatedFireInput
		: T extends 'event_received'
			? EventReceivedFireInput
			: T extends 'topic_subscribed'
				? TopicSubscribedFireInput
				: never;

export interface TriggerModule<T extends TriggerKind, C, FireInput> {
	readonly kind: T;
	/** Parses the automation's persisted triggerConfig blob into a typed value.
	 *  Omitted (and null is passed downstream) for trigger kinds with no config. */
	parseConfig?(raw: unknown): C | null;
	matches(input: FireInput, config: C | null): boolean;
	buildTriggerData?(input: FireInput, config: C | null): TriggerData;
	/**
	 * Optional query-time enrichment — fields merged into the response by
	 * `getWithRelations` so the FE can render derived joins (e.g. the topic
	 * a topic_subscribed trigger references). Only kinds that own a join
	 * implement this; the dispatcher returns `{}` for the rest.
	 */
	enrichForQuery?(ctx: Pick<QueryCtx, 'db'>, config: C | null): Promise<Record<string, unknown>>;
}
