import type { BlockType } from '@owlat/shared';

export interface TemplatePreset {
	id: string;
	name: string;
	description: string;
	icon: string;
	subject: string;
	content: Array<{ id: string; type: BlockType; content: Record<string, unknown> }>;
	previewHtml: string;
}

export const marketingTemplatePresets: TemplatePreset[] = [
	{
		id: 'blank',
		name: 'Start from Blank',
		description: 'Start with an empty canvas',
		icon: 'lucide:align-left',
		subject: '',
		content: [],
		previewHtml: `<div style="padding: 40px; text-align: center; color: #9CA3AF;">
      <p style="font-size: 14px;">Empty canvas - add your own content</p>
    </div>`,
	},
	{
		id: 'welcome',
		name: 'Welcome Email',
		description: 'Perfect for welcoming new subscribers',
		icon: 'lucide:sparkles',
		subject: 'Welcome to {{company}}!',
		content: [
			{
				id: 'welcome-text-1',
				type: 'text',
				content: {
					html: '<h1 style="text-align: center">Welcome aboard, {{firstName}}! </h1>',
					fontSize: 28,
					textColor: '#111827',
				},
			},
			{
				id: 'welcome-spacer-1',
				type: 'spacer',
				content: { height: 16 },
			},
			{
				id: 'welcome-text-2',
				type: 'text',
				content: {
					html: '<p style="text-align: center">We\'re thrilled to have you join our community. Here\'s what you can expect from us:</p>',
					fontSize: 16,
					textColor: '#4B5563',
				},
			},
			{
				id: 'welcome-spacer-2',
				type: 'spacer',
				content: { height: 24 },
			},
			{
				id: 'welcome-text-3',
				type: 'text',
				content: {
					html: '<p><strong>Exclusive updates</strong> - Be the first to know about new features</p><p><strong>Helpful resources</strong> - Tips and guides to help you succeed</p><p><strong>Special offers</strong> - Subscriber-only deals and promotions</p>',
					fontSize: 16,
					textColor: '#374151',
				},
			},
			{
				id: 'welcome-spacer-3',
				type: 'spacer',
				content: { height: 24 },
			},
			{
				id: 'welcome-button-1',
				type: 'button',
				content: {
					text: 'Get Started',
					url: 'https://',
					backgroundColor: '#c4785a',
					textColor: '#ffffff',
					align: 'center',
					borderRadius: 8,
					paddingX: 32,
					paddingY: 14,
					marginTop: 0,
					marginBottom: 0,
				},
			},
			{
				id: 'welcome-spacer-4',
				type: 'spacer',
				content: { height: 32 },
			},
			{
				id: 'welcome-divider-1',
				type: 'divider',
				content: {
					color: '#E5E7EB',
					thickness: 1,
					width: 100,
					style: 'solid',
				},
			},
			{
				id: 'welcome-spacer-5',
				type: 'spacer',
				content: { height: 24 },
			},
			{
				id: 'welcome-text-4',
				type: 'text',
				content: {
					html: '<p style="text-align: center">Have questions? Just reply to this email - we\'re here to help!</p>',
					fontSize: 14,
					textColor: '#6B7280',
				},
			},
		],
		previewHtml: `<div style="padding: 32px; max-width: 100%;">
      <h1 style="text-align: center; font-size: 24px; color: #111827; margin: 0 0 16px 0;">Welcome aboard!</h1>
      <p style="text-align: center; color: #4B5563; font-size: 14px; margin: 0 0 20px 0;">We're thrilled to have you join our community.</p>
      <p style="color: #374151; font-size: 13px; margin: 0 0 6px 0;"><strong>Exclusive updates</strong></p>
      <p style="color: #374151; font-size: 13px; margin: 0 0 6px 0;"><strong>Helpful resources</strong></p>
      <p style="color: #374151; font-size: 13px; margin: 0 0 20px 0;"><strong>Special offers</strong></p>
      <div style="text-align: center;">
        <span style="display: inline-block; background: #c4785a; color: #ffffff; padding: 10px 24px; border-radius: 6px; font-weight: 500; font-size: 13px;">Get Started</span>
      </div>
    </div>`,
	},
	{
		id: 'newsletter',
		name: 'Newsletter',
		description: 'Share updates and news with your audience',
		icon: 'lucide:newspaper',
		subject: 'Your Weekly Update',
		content: [
			{
				id: 'newsletter-text-1',
				type: 'text',
				content: {
					html: '<h1 style="text-align: center">Weekly Newsletter</h1>',
					fontSize: 28,
					textColor: '#111827',
				},
			},
			{
				id: 'newsletter-text-2',
				type: 'text',
				content: {
					html: '<p style="text-align: center; color: #6B7280">Your weekly dose of updates and insights</p>',
					fontSize: 14,
					textColor: '#6B7280',
				},
			},
			{
				id: 'newsletter-spacer-1',
				type: 'spacer',
				content: { height: 24 },
			},
			{
				id: 'newsletter-divider-1',
				type: 'divider',
				content: {
					color: '#E5E7EB',
					thickness: 1,
					width: 100,
					style: 'solid',
				},
			},
			{
				id: 'newsletter-spacer-2',
				type: 'spacer',
				content: { height: 24 },
			},
			{
				id: 'newsletter-text-3',
				type: 'text',
				content: {
					html: '<h2>Top Story</h2>',
					fontSize: 20,
					textColor: '#111827',
				},
			},
			{
				id: 'newsletter-text-4',
				type: 'text',
				content: {
					html: '<p>Your main story content goes here. Share the most important news or update of the week.</p>',
					fontSize: 16,
					textColor: '#374151',
				},
			},
			{
				id: 'newsletter-button-1',
				type: 'button',
				content: {
					text: 'Read More',
					url: 'https://',
					backgroundColor: '#c4785a',
					textColor: '#ffffff',
					align: 'left',
					borderRadius: 6,
					paddingX: 20,
					paddingY: 10,
					marginTop: 12,
					marginBottom: 0,
				},
			},
			{
				id: 'newsletter-spacer-3',
				type: 'spacer',
				content: { height: 32 },
			},
			{
				id: 'newsletter-text-5',
				type: 'text',
				content: {
					html: '<h2>Quick Links</h2>',
					fontSize: 20,
					textColor: '#111827',
				},
			},
			{
				id: 'newsletter-text-6',
				type: 'text',
				content: {
					html: '<p>- <a href="#">Link to article or resource 1</a></p><p>- <a href="#">Link to article or resource 2</a></p><p>- <a href="#">Link to article or resource 3</a></p>',
					fontSize: 16,
					textColor: '#374151',
				},
			},
			{
				id: 'newsletter-spacer-4',
				type: 'spacer',
				content: { height: 32 },
			},
			{
				id: 'newsletter-divider-2',
				type: 'divider',
				content: {
					color: '#E5E7EB',
					thickness: 1,
					width: 100,
					style: 'solid',
				},
			},
			{
				id: 'newsletter-spacer-5',
				type: 'spacer',
				content: { height: 24 },
			},
			{
				id: 'newsletter-text-7',
				type: 'text',
				content: {
					html: '<p style="text-align: center">Thanks for reading! See you next week.</p>',
					fontSize: 14,
					textColor: '#6B7280',
				},
			},
		],
		previewHtml: `<div style="padding: 24px; max-width: 100%;">
      <h1 style="text-align: center; font-size: 22px; color: #111827; margin: 0 0 4px 0;">Weekly Newsletter</h1>
      <p style="text-align: center; color: #6B7280; font-size: 12px; margin: 0 0 16px 0;">Your weekly dose of updates</p>
      <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 16px 0;">
      <h2 style="font-size: 16px; color: #111827; margin: 0 0 8px 0;">Top Story</h2>
      <p style="color: #374151; font-size: 13px; margin: 0 0 12px 0;">Your main story content goes here...</p>
      <span style="display: inline-block; background: #c4785a; color: #ffffff; padding: 6px 14px; border-radius: 4px; font-size: 12px;">Read More</span>
      <h2 style="font-size: 16px; color: #111827; margin: 24px 0 8px 0;">Quick Links</h2>
      <p style="color: #374151; font-size: 13px; margin: 0;">- Link 1 - Link 2 - Link 3</p>
    </div>`,
	},
	{
		id: 'announcement',
		name: 'Announcement',
		description: 'Make important announcements stand out',
		icon: 'lucide:megaphone',
		subject: 'Big News: {{announcement_title}}',
		content: [
			{
				id: 'announcement-spacer-1',
				type: 'spacer',
				content: { height: 32 },
			},
			{
				id: 'announcement-text-1',
				type: 'text',
				content: {
					html: '<p style="text-align: center; color: #c4785a; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em">Announcement</p>',
					fontSize: 12,
					textColor: '#c4785a',
				},
			},
			{
				id: 'announcement-text-2',
				type: 'text',
				content: {
					html: '<h1 style="text-align: center">Something Exciting is Coming!</h1>',
					fontSize: 32,
					textColor: '#111827',
				},
			},
			{
				id: 'announcement-spacer-2',
				type: 'spacer',
				content: { height: 24 },
			},
			{
				id: 'announcement-text-3',
				type: 'text',
				content: {
					html: '<p style="text-align: center">We\'re thrilled to share some big news with you. This is where you can describe your announcement, whether it\'s a new product, feature, event, or milestone.</p>',
					fontSize: 18,
					textColor: '#4B5563',
				},
			},
			{
				id: 'announcement-spacer-3',
				type: 'spacer',
				content: { height: 32 },
			},
			{
				id: 'announcement-button-1',
				type: 'button',
				content: {
					text: 'Learn More',
					url: 'https://',
					backgroundColor: '#c4785a',
					textColor: '#ffffff',
					align: 'center',
					borderRadius: 8,
					paddingX: 40,
					paddingY: 16,
					marginTop: 0,
					marginBottom: 0,
				},
			},
			{
				id: 'announcement-spacer-4',
				type: 'spacer',
				content: { height: 48 },
			},
			{
				id: 'announcement-divider-1',
				type: 'divider',
				content: {
					color: '#E5E7EB',
					thickness: 1,
					width: 60,
					style: 'solid',
				},
			},
			{
				id: 'announcement-spacer-5',
				type: 'spacer',
				content: { height: 24 },
			},
			{
				id: 'announcement-text-4',
				type: 'text',
				content: {
					html: '<p style="text-align: center">Questions? We\'d love to hear from you.<br>Just reply to this email.</p>',
					fontSize: 14,
					textColor: '#6B7280',
				},
			},
		],
		previewHtml: `<div style="padding: 32px; text-align: center; max-width: 100%;">
      <p style="color: #c4785a; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; font-size: 11px; margin: 0 0 8px 0;">Announcement</p>
      <h1 style="font-size: 24px; color: #111827; margin: 0 0 16px 0;">Something Exciting is Coming!</h1>
      <p style="color: #4B5563; font-size: 14px; margin: 0 0 24px 0;">We're thrilled to share some big news with you...</p>
      <span style="display: inline-block; background: #c4785a; color: #ffffff; padding: 12px 32px; border-radius: 6px; font-weight: 500; font-size: 14px;">Learn More</span>
    </div>`,
	},
	{
		id: 'product-update',
		name: 'Product Update',
		description: 'Showcase new features and improvements',
		icon: 'lucide:package',
		subject: 'New in {{product_name}}: {{feature_name}}',
		content: [
			{
				id: 'product-text-1',
				type: 'text',
				content: {
					html: '<p style="text-align: center; color: #6B7280">Product Update</p>',
					fontSize: 14,
					textColor: '#6B7280',
				},
			},
			{
				id: 'product-text-2',
				type: 'text',
				content: {
					html: '<h1 style="text-align: center">Introducing Our Latest Feature</h1>',
					fontSize: 28,
					textColor: '#111827',
				},
			},
			{
				id: 'product-spacer-1',
				type: 'spacer',
				content: { height: 24 },
			},
			{
				id: 'product-image-1',
				type: 'image',
				content: {
					src: '',
					alt: 'Feature screenshot',
					width: 100,
					align: 'center',
				},
			},
			{
				id: 'product-spacer-2',
				type: 'spacer',
				content: { height: 24 },
			},
			{
				id: 'product-text-3',
				type: 'text',
				content: {
					html: "<h2>What's New</h2>",
					fontSize: 20,
					textColor: '#111827',
				},
			},
			{
				id: 'product-text-4',
				type: 'text',
				content: {
					html: '<p>Describe the new feature or update here. Explain what it does and why your users will love it.</p>',
					fontSize: 16,
					textColor: '#374151',
				},
			},
			{
				id: 'product-spacer-3',
				type: 'spacer',
				content: { height: 16 },
			},
			{
				id: 'product-text-5',
				type: 'text',
				content: {
					html: '<h2>Key Benefits</h2>',
					fontSize: 20,
					textColor: '#111827',
				},
			},
			{
				id: 'product-text-6',
				type: 'text',
				content: {
					html: '<p><strong>Benefit one</strong> - Explain the value</p><p><strong>Benefit two</strong> - Explain the value</p><p><strong>Benefit three</strong> - Explain the value</p>',
					fontSize: 16,
					textColor: '#374151',
				},
			},
			{
				id: 'product-spacer-4',
				type: 'spacer',
				content: { height: 24 },
			},
			{
				id: 'product-button-1',
				type: 'button',
				content: {
					text: 'Try It Now',
					url: 'https://',
					backgroundColor: '#c4785a',
					textColor: '#ffffff',
					align: 'center',
					borderRadius: 8,
					paddingX: 32,
					paddingY: 14,
					marginTop: 0,
					marginBottom: 0,
				},
			},
			{
				id: 'product-spacer-5',
				type: 'spacer',
				content: { height: 32 },
			},
			{
				id: 'product-divider-1',
				type: 'divider',
				content: {
					color: '#E5E7EB',
					thickness: 1,
					width: 100,
					style: 'solid',
				},
			},
			{
				id: 'product-spacer-6',
				type: 'spacer',
				content: { height: 24 },
			},
			{
				id: 'product-text-7',
				type: 'text',
				content: {
					html: '<p style="text-align: center">Need help getting started? Check out our <a href="#">documentation</a> or <a href="#">contact support</a>.</p>',
					fontSize: 14,
					textColor: '#6B7280',
				},
			},
		],
		previewHtml: `<div style="padding: 24px; max-width: 100%;">
      <p style="text-align: center; color: #6B7280; font-size: 12px; margin: 0 0 4px 0;">Product Update</p>
      <h1 style="text-align: center; font-size: 20px; color: #111827; margin: 0 0 16px 0;">Introducing Our Latest Feature</h1>
      <div style="background: #F3F4F6; height: 80px; border-radius: 6px; margin-bottom: 16px; display: flex; align-items: center; justify-content: center; color: #9CA3AF; font-size: 12px;">[Feature Image]</div>
      <h2 style="font-size: 16px; color: #111827; margin: 0 0 8px 0;">What's New</h2>
      <p style="color: #374151; font-size: 13px; margin: 0 0 16px 0;">Describe the new feature here...</p>
      <h2 style="font-size: 16px; color: #111827; margin: 0 0 8px 0;">Key Benefits</h2>
      <p style="color: #374151; font-size: 13px; margin: 0 0 4px 0;"><strong>Benefit one</strong></p>
      <p style="color: #374151; font-size: 13px; margin: 0 0 16px 0;"><strong>Benefit two</strong></p>
      <div style="text-align: center;">
        <span style="display: inline-block; background: #c4785a; color: #ffffff; padding: 10px 24px; border-radius: 6px; font-weight: 500; font-size: 13px;">Try It Now</span>
      </div>
    </div>`,
	},
	{
		id: 'plain-text',
		name: 'Plain Text',
		description: 'Simple text-only email for personal touch',
		icon: 'lucide:align-left',
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
	},
];

export function getPresetById(id: string): TemplatePreset | undefined {
	return marketingTemplatePresets.find((p) => p.id === id);
}
