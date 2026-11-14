import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tokenFingerprint } from '../core/redact';

/** Dấu hiệu token bị Discord từ chối, để watchdog không dựng lại liên tục. */
const PATH = process.env.QUEST_BOT_MARKER ?? '.quest-bot-dead';

export interface Rejected {
	at: string;
	fingerprint: string;
	reason: string;
}

export function markTokenRejected(token: string, reason: string): void {
	try {
		writeFileSync(
			PATH,
			JSON.stringify({ at: new Date().toISOString(), fingerprint: tokenFingerprint(token), reason }, null, 2),
			{ mode: 0o600 },
		);
	} catch {
		/* không quan trọng bằng việc báo lỗi */
	}
}

export function readMarker(): Rejected | null {
	if (!existsSync(PATH)) return null;
	try {
		return JSON.parse(readFileSync(PATH, 'utf8')) as Rejected;
	} catch {
		return null;
	}
}

export function clearMarker(): void {
	try {
		if (existsSync(PATH)) unlinkSync(PATH);
	} catch {
		/* bỏ qua */
	}
}

/** Token hiện tại đã từng bị từ chối chưa? */
export function rejectedBefore(token: string): Rejected | null {
	const marker = readMarker();
	if (!marker) return null;
	return marker.fingerprint === tokenFingerprint(token) ? marker : null;
}
