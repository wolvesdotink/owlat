import { registerClientSimulator } from './registry';

// New Outlook (Edge/WebView2): modern CSS support, but still strips forms.
registerClientSimulator('outlookNew', (html) =>
	html
		.replace(/<input[^>]*>/gi, '<!-- [outlook-new: input stripped] -->')
		.replace(/<form[^>]*>[\s\S]*?<\/form>/gi, '<!-- [outlook-new: form stripped] -->'),
);
