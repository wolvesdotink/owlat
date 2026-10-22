import rule from '../noLogPii.ts';
import { ruleTester } from '../../__tests__/ruleTester.ts';

const filename = '/repo/apps/api/convex/inbound/log.ts';
const options = [{ files: ['apps/api/convex/**'] }];
const reported = (key: string) => ({ message: new RegExp(`^\`${key}\` puts a correspondent`) });

ruleTester.run('owlat/no-log-pii', rule, {
	valid: [
		{
			name: 'values passed through the redaction helpers',
			filename,
			options,
			code: [
				"logWarn('[Inbound Email] duplicate delivery', {",
				'\tmessageId: args.messageId,',
				'\tfrom: redactEmailAddress(args.from),',
				'\tto: args.to.map(redactEmailAddress),',
				'\tsubject: redactSubject(args.subject),',
				'\tsender: redactionDigest(args.sender),',
				'\trecipient: redactEmailAddresses([args.recipient]),',
				'});',
			].join('\n'),
		},
		{
			name: 'qualified names: a domain, a count, an id or a digest',
			filename,
			options,
			code: "logInfo('delivered', { fromDomain: d, toCount: 3, senderId: id, recipientHash: h, addressCount: 3 });",
		},
		{
			name: 'an inline log-pii-safe justification',
			filename,
			options,
			code: [
				"logInfo('webhook received', {",
				'\t// log-pii-safe: the provider routing label, not a mailbox',
				'\tfrom: payload.queueName,',
				'});',
			].join('\n'),
		},
		{
			name: 'a justification in the comment lines directly above',
			filename,
			options,
			code: [
				'// The header names are constants.',
				'// log-pii-safe: header NAMES, never their values',
				"logInfo('headers dropped', { from: HEADER_FROM, subject: HEADER_SUBJECT });",
			].join('\n'),
		},
		{
			name: 'object keys outside a log call',
			filename,
			options,
			code: "await ctx.runMutation(internal.inbox.transition, { inboundMessageId, to: 'archived', from: args.from });",
		},
		{
			name: 'an unrelated console-like object',
			filename,
			options,
			code: "logger.warn('x', { from: args.from });",
		},
		{
			name: 'an unrelated console method',
			filename,
			options,
			code: 'console.table({ from: args.from });',
		},
		{
			name: 'a computed call',
			filename,
			options,
			code: "loggers['logInfo' + suffix]('x', { from: args.from });",
		},
		{
			name: 'test files',
			filename: '/repo/apps/api/convex/inbound/log.test.ts',
			options,
			code: "logInfo('x', { from: args.from });",
		},
		{
			name: 'a file without log calls',
			filename,
			options,
			code: 'export const envelope = { from: args.from };',
		},
	],
	invalid: [
		{
			name: 'a multi-line payload carrying from / to / subject',
			filename,
			options,
			code: [
				"logWarn('[Inbound Email] duplicate delivery', {",
				'\tmessageId: args.messageId,',
				'\tfrom: args.from,',
				'\tto: args.to,',
				'\tsubject: args.subject,',
				'});',
			].join('\n'),
			errors: [reported('from'), reported('to'), reported('subject')],
		},
		{
			name: 'raw console calls and member log helpers',
			filename,
			options,
			code: "console.warn('bounced', { rcptTo: job.rcptTo });\nruntime.logError('x', { mailFrom: m });",
			errors: [reported('rcptTo'), reported('mailFrom')],
		},
		{
			name: 'shorthand and quoted keys',
			filename,
			options,
			code: "logInfo('sent', { email, 'address': addr, ['sender']: s });",
			errors: [reported('email'), reported('address'), reported('sender')],
		},
		{
			name: 'a raw address beside a separately redacted subject on one line',
			filename,
			options,
			code: "logInfo('sent', { to: args.to, subject: redactSubject(args.subject) });",
			errors: [reported('to')],
		},
		{
			name: 'a key nested in the payload',
			filename,
			options,
			code: "logDebug('x', { envelope: { from: args.from } }, [{ recipient: r }]);",
			errors: [reported('from'), reported('recipient')],
		},
		{
			name: 'a call longer than any line cap',
			filename,
			options,
			code: `logInfo('long', {\n${Array.from({ length: 30 }, (_, i) => `\tfield${i}: ${i},`).join('\n')}\n\tto: args.to,\n});`,
			errors: [reported('to')],
		},
		{
			name: 'a justification does not leak onto a later call',
			filename,
			options,
			code: [
				'// log-pii-safe: this one is a label',
				"logInfo('a', { from: label });",
				'',
				'const x = 1;',
				'',
				"logInfo('b', { from: args.from });",
			].join('\n'),
			errors: [reported('from')],
		},
		{
			name: 'an empty justification does not count',
			filename,
			options,
			code: "// log-pii-safe:\nlogInfo('a', { from: args.from });",
			errors: [reported('from')],
		},
		{
			name: 'a payload built in a callback',
			filename,
			options,
			code: "logInfo('mapped', { recipients: items.map((item) => ({ to: item.to })) });",
			errors: [reported('to')],
		},
		{
			name: 'a nested log call is reported once',
			filename,
			options,
			code: "logInfo('outer', logWarn('inner', { to: args.to }));",
			errors: [reported('to')],
		},
	],
});
