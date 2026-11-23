/**
 * Đổi IP như VPN cho từng tài khoản.
 *
 * Nguyên tắc Discord chấm điểm: một token chỉ được sống ở MỘT IP tại một thời điểm.
 * Đổi IP tuần tự (VN → ID, nhận quest, ID → VN) thì không sao; hai IP song song trong
 * vài giây thì bị coi là phiên bị đánh cắp và token chết.
 *
 * Vì vậy mọi thứ đi qua đây: trước khi đổi, tài khoản được đánh dấu "đang chuyển" để
 * request khác chờ; gateway của tài khoản bị ngắt; proxy mới mở; request enroll đi
 * qua proxy đó; xong thì đóng proxy và trả tài khoản về IP cũ.
 */

import { openProxy, closeProxy, type FactoryProxy } from './proxyFactory';
import { logger } from './logger';

interface Switch {
	proxy: FactoryProxy;
	previous: string | null;
	country: string;
	at: number;
}

const switched = new Map<string, Switch>();
const busy = new Set<string>();

/** Proxy đang được gán cho tài khoản, nếu đang ở chế độ đổi IP. */
export function activeProxy(tokenId: string | undefined): string | null {
	if (!tokenId) return null;
	return switched.get(tokenId)?.proxy.url ?? null;
}

/** Nước hiện tại của tài khoản: đang chuyển thì là nước proxy, còn lại là null. */
export function activeCountry(tokenId: string | undefined): string | null {
	if (!tokenId) return null;
	return switched.get(tokenId)?.country ?? null;
}

export function isSwitching(tokenId: string): boolean {
	return busy.has(tokenId);
}

/** Chờ cho tài khoản không còn đang chuyển IP. */
async function waitIdle(tokenId: string, timeoutMs = 20_000): Promise<void> {
	const until = Date.now() + timeoutMs;
	while (busy.has(tokenId) && Date.now() < until) {
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

/**
 * Chuyển tài khoản sang nước `country`, chạy `work` ở IP mới, rồi trả về như cũ.
 * Không có proxy thì `work` chạy ở IP hiện tại và không đổi gì.
 */
export async function withEgressCountry<T>(
	tokenId: string,
	country: string | null,
	work: (proxyUrl: string | null) => Promise<T>,
): Promise<T> {
	if (!country) return work(activeProxy(tokenId));

	await waitIdle(tokenId);
	busy.add(tokenId);

	const previous = activeProxy(tokenId);
	let proxy: FactoryProxy | null = null;
	try {
		// Gateway phải ngắt trước khi đổi IP, nếu không token sống ở hai IP cùng lúc.
		const { disconnectGateway } = await import('../api/gateway');
		disconnectGateway(tokenId);
		await new Promise((resolve) => setTimeout(resolve, 1_500));

		proxy = await openProxy(tokenId, country).catch(() => null);
		if (!proxy) {
			logger.warn(`Không mở được proxy ${country.toUpperCase()}, nhận quest ở IP hiện tại.`);
			return await work(previous);
		}

		switched.set(tokenId, { proxy, previous, country: proxy.country, at: Date.now() });
		logger.info(`Đổi IP ${tokenId.slice(0, 6)} → ${proxy.country.toUpperCase()} để nhận quest.`);

		// Cho request cũ kịp xong trước khi request mới rời IP mới.
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		return await work(proxy.url);
	} finally {
		if (proxy) {
			// Trả về IP cũ: đóng proxy, đợi một nhịp để không có request nào chen giữa.
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			closeProxy(tokenId, proxy.country);
			if (previous) switched.set(tokenId, { ...switched.get(tokenId)!, proxy: { ...proxy, url: previous } });
			else switched.delete(tokenId);
			logger.info(`Trả IP ${tokenId.slice(0, 6)} về như trước.`);
		}
		busy.delete(tokenId);
	}
}
