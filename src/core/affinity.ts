/**
 * Gắn mỗi tài khoản với một IP ra cố định.
 *
 * Vì sao cần: Discord nhìn IP để chấm điểm. Một tài khoản nhảy IP liên tục giữa
 * các request trông đáng ngờ hơn nhiều so với một tài khoản đi đều một IP, và
 * nhiều tài khoản cùng dồn vào một IP thì IP đó bị coi là spam. Ở đây tài khoản
 * được băm ra một proxy cố định, proxy chết thì nghỉ một lúc rồi mới đổi.
 */

import { loadProxies } from './proxies';
import { gatePenalize } from './gate';
import { logger } from './logger';

interface Failure {
	cooldownUntil: number;
}

const failures = new Map<string, Failure>();

function hash(text: string): number {
	let value = 2166136261;
	for (let i = 0; i < text.length; i += 1) {
		value ^= text.charCodeAt(i);
		value = Math.imul(value, 16777619);
	}
	return Math.abs(value);
}

function enabled(): boolean {
	// Chỉ bật khi có proxy và người dùng không tắt rõ ràng.
	if (process.env.PROXY_PER_ACCOUNT === '0') return false;
	return true;
}

/**
 * Kéo dài thời gian sống của phiên proxy.
 *
 * Proxy dạng `...-session-<id>-life-5m` sẽ đổi IP sau 5 phút. Một token mà cứ
 * vài phút lại xuất hiện từ IP khác chính là kiểu Discord nghi bị đánh cắp rồi
 * vô hiệu hoá. Đặt PROXY_SESSION_LIFE (mặc định 60m) để giữ nguyên IP lâu hơn.
 */
export function stabilizeProxyUrl(url: string): string {
	// 30m là mức nhiều nhà cung cấp còn cho phép; đặt rỗng để giữ nguyên như danh sách.
	const life = (process.env.PROXY_SESSION_LIFE ?? '30m').trim();
	if (!life) return url;
	return url.replace(/life-\d+[smh]/g, `life-${life}`);
}

export interface Egress {
	/** Khoá dùng cho cửa van: 'direct' hoặc URL proxy. */
	key: string;
	proxyUrl?: string;
}

/** IP ra mà tài khoản này nên dùng. Không có proxy thì đi thẳng. */
export async function egressFor(tokenId?: string): Promise<Egress> {
	if (!enabled() || !tokenId) return { key: 'direct' };

	const proxies = await loadProxies().catch(() => []);
	if (proxies.length === 0) return { key: 'direct' };

	const now = Date.now();
	const alive = proxies.filter((entry) => (failures.get(entry.url)?.cooldownUntil ?? 0) <= now);
	const pool = alive.length > 0 ? alive : proxies;
	const picked = pool[hash(tokenId) % pool.length];
	const proxyUrl = stabilizeProxyUrl(picked.url);

	// Một token phải luôn đi ra từ cùng một IP. Nếu IP đổi giữa phiên thì đó là
	// dấu hiệu token sắp bị Discord vô hiệu, nên ghi lại để còn thấy trong log.
	void watchIp(tokenId, proxyUrl);

	return { key: proxyUrl, proxyUrl };
}

/** Ghi nhận một lần hỏng để tạm loại proxy đó khỏi vòng chọn. */
export function noteEgressFailure(key: string, ms = 60_000): void {
	if (key === 'direct') {
		// Đi thẳng hỏng thì cho cả khoá nghỉ, tránh dập liên tục.
		gatePenalize('direct', Math.min(ms, 30_000));
		return;
	}
	failures.set(key, { cooldownUntil: Date.now() + ms });
}

const seenIp = new Map<string, { ip: string; at: number }>();

/** Theo dõi IP ra của từng tài khoản, cảnh báo khi nó nhảy. */
async function watchIp(tokenId: string, proxyUrl: string): Promise<void> {
	const now = Date.now();
	const previous = seenIp.get(tokenId);
	if (previous && now - previous.at < 10 * 60 * 1000) return;

	try {
		const { ProxyAgent, fetch: undiciFetch } = await import('undici');
		const res = await undiciFetch('https://api.ipify.org?format=json', {
			dispatcher: new ProxyAgent(proxyUrl),
			signal: AbortSignal.timeout(8000),
		});
		const body = (await res.json()) as { ip?: string };
		const ip = body.ip?.trim();
		if (!ip) return;
		if (previous && previous.ip !== ip) {
			logger.warn(
				`Tài khoản ${tokenId.slice(0, 6)} đổi IP ra ${previous.ip} → ${ip}; nên dùng proxy giữ phiên lâu hơn.`,
			);
		}
		seenIp.set(tokenId, { ip, at: now });
	} catch {
		/* đo IP lỗi thì bỏ qua, không ảnh hưởng request thật */
	}
}

export function egressFailures(): { key: string; cooldownMs: number }[] {
	const now = Date.now();
	return [...failures.entries()]
		.map(([key, failure]) => ({ key, cooldownMs: Math.max(0, failure.cooldownUntil - now) }))
		.filter((entry) => entry.cooldownMs > 0);
}
