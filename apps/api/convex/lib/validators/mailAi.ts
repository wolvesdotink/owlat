import { v } from 'convex/values';

// Mailbox-AI validators shared by schema/mailAi.ts and the functions that
// read or write those tables.

// A learned writing-voice profile (`mailVoiceProfiles.profile`), derived from
// the owner's sent mail by mail/ai/voiceProfile.ts. `VoiceProfile` in
// mail/ai/voiceProfileText.ts is inferred from this.
export const voiceProfileValidator = v.object({
	greetings: v.array(v.string()),
	signOffs: v.array(v.string()),
	formality: v.number(), // 1 (very casual) … 5 (very formal)
	brevity: v.number(), // 1 (terse) … 5 (elaborate)
	languages: v.array(v.string()),
	isEmojiUser: v.boolean(),
	examplePhrasings: v.array(v.string()),
});
