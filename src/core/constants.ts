// Members of this server get quest rewards. Everyone else can still run
// quests, but the claim step is skipped.
export const REQUIRED_GUILD_ID = '1503409916482814003';
export const GUILD_INVITE_CODE = '7ERYA9ArWH';
export const GUILD_INVITE_URL = `https://discord.gg/${GUILD_INVITE_CODE}`;

export const API = 'https://discord.com/api/v10';

// Pause between two requests of the same token. Wide enough that a run looks
// like a person clicking through quests, not a script.
export const API_DELAY_MS = [1500, 3000] as const;

// The auto loop lists quests again on this interval.
export const AUTO_INTERVAL_MS = 5 * 60 * 1000;
