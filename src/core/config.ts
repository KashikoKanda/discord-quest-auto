import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export function loadEnv(file = '.env'): void {
	if (!existsSync(file)) return;
	for (const raw of readFileSync(file, 'utf8').split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		let value = line
			.slice(eq + 1)
			.trim()
			.replace(/^['"]|['"]$/g, '');
		if (process.env[key] === undefined) process.env[key] = value;
	}
}

export function tokenIdFor(token: string): string {
	return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export function getToken(explicit?: string): string {
	const token = (explicit ?? process.env.TOKEN ?? '').trim();
	if (!token) {
		throw new Error('Thiếu token. Đặt TOKEN=... trong .env (hoặc truyền --token).');
	}
	return token;
}

function statePath(): string {
	return process.env.QUEST_STATE ?? '.quest-state.json';
}

export interface State {
	pid: number;
	mode: string;
	tokenId: string;
	startedAt: number;
	logFile?: string;
}

export function readState(): State | null {
	try {
		const path = statePath();
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, 'utf8')) as State;
	} catch {
		return null;
	}
}

let pendingState: State | null = null;
let flushTimer: NodeJS.Timeout | null = null;

/**
 * Ghi state an toàn khi nhiều tài khoản chạy cùng lúc: gộp các lần ghi trong 200ms,
 * ghi ra file tạm rồi rename để không bao giờ có file nửa vời và không hai tiến
 * trình cùng cắt ngang một file.
 */
export function writeState(state: State): void {
	pendingState = state;
	if (flushTimer) return;
	flushTimer = setTimeout(() => {
		flushTimer = null;
		const data = pendingState;
		pendingState = null;
		if (!data) return;
		try {
			const path = statePath();
			const tmp = `${path}.tmp`;
			writeFileSync(tmp, JSON.stringify(data));
			renameSync(tmp, path);
		} catch {
			/* ghi lỗi không được làm chết vòng chạy quest */
		}
	}, 200);
	flushTimer.unref?.();
}

export function clearState(): void {
	try {
		rmSync(statePath(), { force: true });
	} catch {
		/* ignore */
	}
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
