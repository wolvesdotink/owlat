import { ChevronDown } from '@lucide/vue';
import { moduleFor } from '@owlat/email-renderer';
import type { EditorModule, NestedChild } from '../_module';
import type { AccordionBlockContent } from '../../types';
import { accordionSchema } from '../../schema/definitions/accordion';
import { defaultPadding, defaultMargin } from '../../defaults';
import { generateId } from '../../utils/id';

export const accordionEditor: EditorModule<'accordion'> = {
	type: 'accordion',
	label: 'Accordion',
	icon: ChevronDown,
	schema: accordionSchema,
	slashCommand: {
		name: 'Accordion',
		description: 'Collapsible content sections',
		category: 'layout',
		aliases: ['collapse', 'faq', 'toggle'],
	},
	canBeInColumn: false,
	canBeInContainer: false,

	// Renderer's accordion.createDefault uses static section IDs that work for
	// validation tests; the builder swaps in fresh generated IDs so each
	// inserted accordion has unique section ids.
	createDefault: (theme) => {
		const base = moduleFor('accordion')!.createDefault!(theme) as AccordionBlockContent;
		return {
			...base,
			sections: base.sections.map((s) => ({ ...s, id: generateId() })),
			...defaultPadding,
			...defaultMargin,
		} as AccordionBlockContent;
	},

	childrenView(block): NestedChild[] {
		return (block.content.sections ?? []).map((section) => ({
			id: section.id,
			type: 'section',
			label: section.title || 'Untitled Section',
			icon: null,
		}));
	},

	// Accordion children are sections, not arbitrary blocks — no block insertion.
	allowedChildTypes() {
		return [];
	},
};
