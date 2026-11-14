/** REST thuần cho bot: danh tính, slash command, trả lời interaction. */
import { redact } from '../core/redact';

const API = 'https://discord.com/api/v10';

export interface BotUser {
	id: string;
	username: string;
	discriminator?: string;
	bot?: boolean;
}

let botToken = '';
let botId = '';

export function setBotToken(token: string): void {
	botToken = token;
}

export function getBotId(): string {
	return botId;
}

export async function botFetch(path: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('Authorization', `Bot ${botToken}`);
	headers.set('User-Agent', 'DiscordBot (https://github.com/KashikoKanda/discord-quest-auto, 1.0.0)');
	if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
	return fetch(`${API}${path}`, { ...init, headers });
}

export async function getMe(): Promise<BotUser> {
	const res = await botFetch('/users/@me');
	if (!res.ok) throw new Error(`Bot token không dùng được (HTTP ${res.status})`);
	const me = (await res.json()) as BotUser;
	botId = me.id;
	return me;
}

/** Đăng ký global slash command; gọi lại nhiều lần không sao. */
export async function registerCommands(commands: unknown[]): Promise<void> {
	const res = await botFetch(`/applications/${botId}/commands`, {
		method: 'PUT',
		body: JSON.stringify(commands),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(redact(`Đăng ký slash command thất bại (HTTP ${res.status}): ${text.slice(0, 200)}`));
	}
}

export async function replyInteraction(
	interactionId: string,
	interactionToken: string,
	body: Record<string, unknown>,
): Promise<void> {
	const res = await fetch(`${API}/interactions/${interactionId}/${interactionToken}/callback`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(redact(`Trả lời interaction thất bại (HTTP ${res.status}): ${text.slice(0, 200)}`));
	}
}

/** Sửa tin nhắn gốc của interaction (sau khi đã defer). */
export async function editOriginal(
	interactionToken: string,
	body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
	const res = await fetch(`${API}/webhooks/${botId}/${interactionToken}/messages/@original`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) return null;
	return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

export async function followUp(interactionToken: string, body: Record<string, unknown>): Promise<void> {
	const res = await fetch(`${API}/webhooks/${botId}/${interactionToken}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(redact(`Gửi tin nhắn thất bại (HTTP ${res.status}): ${text.slice(0, 200)}`));
	}
}

export const EPHEMERAL = 64;
