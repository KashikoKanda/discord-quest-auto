/**
 * Danh sách proxy đọc từ nguồn ngoài.
 *
 * Proxy không nằm trong repo: bot tải danh sách từ một URL (thường là raw GitHub)
 * hoặc một file cục bộ, giữ bản lưu trên đĩa để lần chạy sau vẫn có, và chỉ tải lại
 * khi danh sách cũ hết hạn. Cập nhật danh sách trên GitHub là bot tự thấy.
 *
 * Định dạng mỗi dòng, dòng trống và dòng bắt đầu bằng # bị bỏ qua:
 *   host:port
 *   host:port:user:pass
 *   user:pass@host:port
 *   http://user:pass@host:port
 *   host:port:user:pass#DE        ← thẻ quốc gia sau dấu #, dùng để chọn proxy
 */

import { readFileSync, writeFileSync } from 'node:fs';

const DISK_CACHE = '.quest-proxies.json';
const DEFAULT_REFRESH_MS = 10 * 60 * 1000;

export interface ProxyEntry {
	/** URL đầy đủ dùng cho ProxyAgent. */
	url: string;
	/** Thẻ quốc gia nếu dòng proxy có ghi, ví dụ DE, JP. */
	country: string | null;
	/** host:port để hiển thị, không kèm mật khẩu. */
	label: string;
}

let memory: { at: number; entries: ProxyEntry[] } | null = null;
let cursor = 0;

function refreshMs(): number {
	const minutes = Number(process.env.PROXY_REFRESH_MIN ?? '');
	if (Number.isFinite(minutes) && minutes > 0) return minutes * 60 * 1000;
	return DEFAULT_REFRESH_MS;
}

/** Nguồn danh sách: ưu tiên URL, sau đó file cục bộ. */
export function proxySource(): { url?: string; file?: string } {
	return {
		url: process.env.PROXY_LIST_URL?.trim() || undefined,
		file: process.env.PROXY_LIST_FILE?.trim() || undefined,
	};
}

export function parseProxyLine(line: string): ProxyEntry | null {
	const raw = line.trim();
	if (!raw || raw.startsWith('#') || raw.startsWith('//')) return null;

	const [body, tag] = raw.split('#', 2);
	const country = tag?.trim().toUpperCase() || null;
	let text = body.trim();
	if (!text) return null;

	let scheme = 'http';
	const schemeMatch = text.match(/^(https?|socks5h?|socks4):\/\//i);
	if (schemeMatch) {
		scheme = schemeMatch[1].toLowerCase();
		text = text.slice(schemeMatch[0].length);
	}

	const atIndex = text.lastIndexOf('@');
	let auth: string | null = null;
	if (atIndex !== -1) {
		auth = text.slice(0, atIndex);
		text = text.slice(atIndex + 1);
	}

	const parts = text.split(':');
	let host = '';
	let port = '';
	let user = '';
	let pass = '';

	if (auth !== null) {
		host = parts[0] ?? '';
		port = parts[1] ?? '';
		const [a, b] = auth.split(':', 2);
		user = a ?? '';
		pass = b ?? '';
	} else if (parts.length === 2) {
		host = parts[0] ?? '';
		port = parts[1] ?? '';
	} else if (parts.length === 4) {
		host = parts[0] ?? '';
		port = parts[1] ?? '';
		user = parts[2] ?? '';
		pass = parts[3] ?? '';
	} else {
		return null;
	}

	if (!host || !/^\d{1,5}$/.test(port)) return null;

	const credentials = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
	return {
		url: `${scheme}://${credentials}${host}:${port}`,
		country,
		label: `${host}:${port}${country ? ` (${country})` : ''}`,
	};
}

export function parseProxyList(text: string): ProxyEntry[] {
	const seen = new Set<string>();
	const entries: ProxyEntry[] = [];
	for (const line of text.split(/\r?\n/)) {
		const entry = parseProxyLine(line);
		if (!entry || seen.has(entry.url)) continue;
		seen.add(entry.url);
		entries.push(entry);
	}
	return entries;
}

function readDisk(): { at: number; entries: ProxyEntry[] } | null {
	try {
		const data = JSON.parse(readFileSync(DISK_CACHE, 'utf8')) as { at: number; entries: ProxyEntry[] };
		return Array.isArray(data.entries) ? data : null;
	} catch {
		return null;
	}
}

function writeDisk(entries: ProxyEntry[]): void {
	try {
		writeFileSync(DISK_CACHE, JSON.stringify({ at: Date.now(), entries }));
	} catch {
		/* ghi không được thì thôi */
	}
}

async function download(url: string): Promise<string> {
	const res = await fetch(url, {
		headers: { 'User-Agent': 'discord-quest-auto', Accept: 'text/plain, */*' },
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`Không tải được danh sách proxy (${res.status})`);
	return res.text();
}

/** Danh sách proxy hiện có, tự tải lại khi hết hạn. Không có nguồn thì trả rỗng. */
export async function loadProxies(force = false): Promise<ProxyEntry[]> {
	if (!force && memory && Date.now() - memory.at < refreshMs()) return memory.entries;

	const source = proxySource();
	if (!source.url && !source.file) {
		const disk = readDisk();
		memory = { at: Date.now(), entries: disk?.entries ?? [] };
		return memory.entries;
	}

	try {
		const text = source.url ? await download(source.url) : readFileSync(source.file!, 'utf8');
		const entries = parseProxyList(text);
		memory = { at: Date.now(), entries };
		writeDisk(entries);
		return entries;
	} catch (error) {
		const disk = readDisk();
		if (disk) {
			memory = { at: Date.now(), entries: disk.entries };
			return disk.entries;
		}
		memory = { at: Date.now(), entries: [] };
		throw error;
	}
}

/** Chọn proxy: ưu tiên đúng quốc gia, sau đó xoay vòng toàn bộ danh sách. */
export async function pickProxy(country?: string | null): Promise<ProxyEntry | null> {
	const entries = await loadProxies().catch(() => []);
	if (entries.length === 0) return null;

	const want = country?.toUpperCase();
	if (want) {
		const match = entries.filter((entry) => entry.country === want);
		if (match.length > 0) return match[cursor++ % match.length];
	}
	return entries[cursor++ % entries.length];
}

export function resetProxyCache(): void {
	memory = null;
	cursor = 0;
}

export interface ProxyStatus {
	source: { url?: string; file?: string };
	count: number;
	countries: { code: string; count: number }[];
	untagged: number;
	/** Lần tải gần nhất, null nếu chưa từng tải. */
	loadedAt: number | null;
	/** Nguồn có cấu hình nhưng danh sách rỗng. */
	empty: boolean;
}

/** Tóm tắt danh sách proxy để lệnh /proxy hiển thị. */
export async function proxyStatus(force = false): Promise<ProxyStatus> {
	const entries = await loadProxies(force).catch(() => []);
	const source = proxySource();
	const byCountry = new Map<string, number>();
	let untagged = 0;
	for (const entry of entries) {
		if (!entry.country) {
			untagged += 1;
			continue;
		}
		byCountry.set(entry.country, (byCountry.get(entry.country) ?? 0) + 1);
	}
	return {
		source,
		count: entries.length,
		countries: [...byCountry.entries()]
			.map(([code, count]) => ({ code, count }))
			.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
		untagged,
		loadedAt: memory?.at ?? null,
		empty: (Boolean(source.url) || Boolean(source.file)) && entries.length === 0,
	};
}
