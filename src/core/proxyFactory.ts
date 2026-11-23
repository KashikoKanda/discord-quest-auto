/**
 * Proxy dân dụng tạo theo yêu cầu từ ResiFactory.
 *
 * Vì sao không dùng danh sách tĩnh: quest ẩn khoá vùng cần đúng IP của nước đó, và
 * mỗi tài khoản phải có IP riêng để không bị ghép với người khác. Ở đây mỗi cặp
 * (uid, nước) được tạo một proxy sticky và giữ lại dùng tiếp; uid khác thì proxy
 * khác, cùng nước cũng không dùng chung.
 *
 * API: https://resifactory.net/docs/api — POST /proxies trả danh sách dạng
 * host:port:user:pass, đổi thành URL http://user:pass@host:port cho ProxyAgent.
 */

const BASE = 'https://resifactory.net/api/v1';
// Cloudflare của ResiFactory chặn UA mặc định của thư viện, phải giả trình duyệt.
const BROWSER_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36';

const CREATE_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 2;

export interface FactoryProxy {
	url: string;
	country: string;
	createdAt: number;
}

const cache = new Map<string, FactoryProxy>();

function apiKey(): string | null {
	const key = (process.env.RF_API_TOKEN ?? process.env.RESIFACTORY_API_KEY ?? '').trim();
	return key || null;
}

function pool(): string {
	return (process.env.RF_POOL ?? 'walmart_premium').trim();
}

function sessionMinutes(): number {
	const value = Number(process.env.RF_SESSION_MINUTES ?? '1440');
	return Number.isFinite(value) && value > 0 ? value : 1440;
}

/** ResiFactory chỉ nhận ISO 3166-1 alpha-2; Discord hay trả UK, EU... */
export function normalizeCountry(code: string | null | undefined): string | null {
	if (!code) return null;
	const upper = code.trim().toUpperCase();
	const map: Record<string, string> = {
		UK: 'GB',
		EL: 'GR',
		AN: 'NL',
		XK: 'RS',
		EU: 'DE',
	};
	const fixed = map[upper] ?? upper;
	return /^[A-Z]{2}$/.test(fixed) ? fixed.toLowerCase() : null;
}

function key(uid: string, country: string): string {
	return `${uid}|${country}`;
}

function toProxyUrl(line: string): string | null {
	const parts = line.trim().split(':');
	if (parts.length === 4) {
		const [host, port, user, pass] = parts;
		return `http://${user}:${pass}@${host}:${port}`;
	}
	if (parts.length === 2) return `http://${parts[0]}:${parts[1]}`;
	if (line.startsWith('http://') || line.startsWith('https://')) return line.trim();
	return null;
}

async function call(path: string, body?: Record<string, unknown>): Promise<{ status: number; text: string }> {
	const key = apiKey();
	if (!key) return { status: 0, text: 'Thiếu RF_API_TOKEN' };

	let lastError = '';
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
		try {
			const res = await fetch(`${BASE}${path}`, {
				method: body ? 'POST' : 'GET',
				headers: {
					Authorization: `Bearer ${key}`,
					'Content-Type': 'application/json',
					'User-Agent': BROWSER_UA,
					Accept: 'application/json',
				},
				body: body ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
			});
			const text = await res.text();
			// 4xx là lỗi của mình (sai nước, ví hết), thử lại cũng vô ích.
			if (res.status >= 400 && res.status < 500) return { status: res.status, text };
			if (res.ok) return { status: res.status, text };
			lastError = `${res.status}: ${text.slice(0, 160)}`;
		} catch (error) {
			lastError = (error as Error).message;
		}
	}
	return { status: 0, text: lastError };
}

/** Proxy của đúng cặp (uid, nước); gọi lại thì dùng lại cái đã tạo. */
export async function getOrCreateProxy(uid: string, countryCode: string | null): Promise<FactoryProxy | null> {
	const country = normalizeCountry(countryCode);
	if (!country || !apiKey()) return null;

	const existing = cache.get(key(uid, country));
	if (existing) return existing;

	const res = await call('/proxies', {
		pool: pool(),
		country,
		proxyType: 'sticky',
		sessionDuration: sessionMinutes(),
		quantity: 1,
		protocol: 'http',
		format: 'list',
	});

	if (res.status !== 200 && res.status !== 201) return null;

	let lines: string[] = [];
	try {
		const parsed = JSON.parse(res.text) as { proxies?: unknown; data?: unknown; list?: unknown };
		const raw = parsed.proxies ?? parsed.data ?? parsed.list;
		if (Array.isArray(raw)) lines = raw.map((item) => String(item));
		else if (typeof raw === 'string') lines = raw.split('\n');
	} catch {
		lines = res.text.split('\n');
	}

	for (const line of lines) {
		const url = toProxyUrl(line);
		if (!url) continue;
		const proxy: FactoryProxy = { url, country, createdAt: Date.now() };
		cache.set(key(uid, country), proxy);
		return proxy;
	}
	return null;
}

/** Proxy dùng một lần cho /link: vẫn giữ riêng theo uid, nhưng không gắn với quest. */
export async function getLoginProxy(uid: string): Promise<FactoryProxy | null> {
	const country = normalizeCountry(process.env.RF_LOGIN_COUNTRY ?? 'vn') ?? 'vn';
	return getOrCreateProxy(uid, country);
}

export function releaseFactoryProxy(uid: string, countryCode: string | null): void {
	const country = normalizeCountry(countryCode);
	if (!country) return;
	cache.delete(key(uid, country));
}

export function getFactoryStats(): { total: number; byCountry: Record<string, number>; hasKey: boolean } {
	const byCountry: Record<string, number> = {};
	for (const proxy of cache.values()) byCountry[proxy.country] = (byCountry[proxy.country] ?? 0) + 1;
	return { total: cache.size, byCountry, hasKey: Boolean(apiKey()) };
}

/** Kiểm tra ví và danh sách pool, dùng khi cần chẩn đoán. */
export async function factoryBalance(): Promise<{ ok: boolean; text: string }> {
	const res = await call('/balance');
	return { ok: res.status === 200, text: res.text.slice(0, 400) };
}
