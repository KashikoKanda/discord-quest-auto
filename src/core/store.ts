import { readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';

export interface Fingerprint {
	launchId: string;
	launchSignature: string;
	heartbeatSessionId: string;
	sessionId: string;
	locale: string;
	timezone: string;
	chromeVersion: string;
	userAgent: string;
	osVersion: string;
}

type Shape = { fingerprints: Record<string, Fingerprint> };

const STORE_PATH = process.env.QUEST_STORE ?? '.quest-store.json';

let cache: Shape | null = null;

function read(): Shape {
	if (cache) return cache;
	try {
		if (!existsSync(STORE_PATH)) {
			cache = { fingerprints: {} };
			return cache;
		}
		const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8')) as Partial<Shape>;
		cache = { fingerprints: parsed.fingerprints ?? {} };
	} catch {
		cache = { fingerprints: {} };
	}
	return cache;
}

function persist(): void {
	const tmp = `${STORE_PATH}.tmp`;
	writeFileSync(tmp, JSON.stringify(read(), null, 2), { mode: 0o600 });
	renameSync(tmp, STORE_PATH);
}

export async function loadFingerprint(tokenId: string): Promise<Fingerprint | null> {
	return read().fingerprints[tokenId] ?? null;
}

export async function saveFingerprint(tokenId: string, data: Fingerprint): Promise<void> {
	read().fingerprints[tokenId] = data;
	persist();
}

/** Xoá fingerprint của những tài khoản không còn dùng, giữ file nhỏ. */
export async function pruneFingerprints(keep: Set<string>): Promise<number> {
	const store = read();
	let removed = 0;
	for (const tokenId of Object.keys(store.fingerprints)) {
		if (keep.has(tokenId)) continue;
		delete store.fingerprints[tokenId];
		removed += 1;
	}
	if (removed > 0) persist();
	return removed;
}

/** Kích thước file hiện tại (byte), để báo khi thấy phình to. */
export function storeSize(): number {
	try {
		return statSync(STORE_PATH).size;
	} catch {
		return 0;
	}
}

export async function deleteFingerprint(tokenId: string): Promise<void> {
	const store = read();
	if (!(tokenId in store.fingerprints)) return;
	delete store.fingerprints[tokenId];
	persist();
}
