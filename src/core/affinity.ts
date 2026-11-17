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

	return { key: picked.url, proxyUrl: picked.url };
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

export function egressFailures(): { key: string; cooldownMs: number }[] {
	const now = Date.now();
	return [...failures.entries()]
		.map(([key, failure]) => ({ key, cooldownMs: Math.max(0, failure.cooldownUntil - now) }))
		.filter((entry) => entry.cooldownMs > 0);
}
