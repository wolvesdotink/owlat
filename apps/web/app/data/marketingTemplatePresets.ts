import type { TemplatePreset } from './templatePresets/types';
import { blankPreset, plainTextPreset } from './templatePresets/basics';
import { welcomePreset } from './templatePresets/welcome';
import { newsletterPreset } from './templatePresets/newsletter';
import { announcementPreset, productUpdatePreset } from './templatePresets/announcements';

export type { TemplatePreset } from './templatePresets/types';

/** The template library's presets, in the order its grid shows them. */
export const marketingTemplatePresets: TemplatePreset[] = [
	blankPreset,
	welcomePreset,
	newsletterPreset,
	announcementPreset,
	productUpdatePreset,
	plainTextPreset,
];

export function getPresetById(id: string): TemplatePreset | undefined {
	return marketingTemplatePresets.find((p) => p.id === id);
}
