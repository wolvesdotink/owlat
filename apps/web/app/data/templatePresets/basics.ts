/** The two presets without a design: the empty canvas and a plain personal note. */
import type { TemplatePreset } from './types';
import { TextAlignLeftIcon } from '@coolicons/vue';

export const blankPreset: TemplatePreset = {
	id: 'blank',
	name: 'shared.data.marketingTemplatePresets.blank.name',
	description: 'shared.data.marketingTemplatePresets.blank.description',
	icon: TextAlignLeftIcon,
	subject: '',
	content: [],
	previewHtml: `<div style="padding: 40px; text-align: center; color: #9CA3AF;">
      <p style="font-size: 14px;">Empty canvas - add your own content</p>
    </div>`,
};

export const plainTextPreset: TemplatePreset = {
	id: 'plain-text',
	name: 'shared.data.marketingTemplatePresets.plainText.name',
	description: 'shared.data.marketingTemplatePresets.plainText.description',
	icon: TextAlignLeftIcon,
	subject: 'A quick note from {{sender_name}}',
	content: [
		{
			id: 'plain-text-1',
			type: 'text',
			content: {
				html: '<p>Hi {{firstName}},</p><p>I wanted to reach out personally to share something with you.</p><p>[Your message here]</p><p>If you have any questions, just reply to this email - I read every response.</p><p>Best,<br>[Your name]</p>',
				fontSize: 16,
				textColor: '#374151',
			},
		},
	],
	previewHtml: `<div style="padding: 24px; max-width: 100%;">
      <p style="color: #374151; font-size: 14px; margin: 0 0 12px 0;">Hi {{firstName}},</p>
      <p style="color: #374151; font-size: 14px; margin: 0 0 12px 0;">I wanted to reach out personally to share something with you.</p>
      <p style="color: #374151; font-size: 14px; margin: 0 0 12px 0;">[Your message here]</p>
      <p style="color: #374151; font-size: 14px; margin: 0 0 12px 0;">If you have any questions, just reply to this email.</p>
      <p style="color: #374151; font-size: 14px; margin: 0;">Best,<br>[Your name]</p>
    </div>`,
};
