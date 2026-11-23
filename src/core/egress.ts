/**
 * Nước mà bot đang đi ra khi không dùng proxy.
 *
 * Vì sao cần: Discord coi một token xuất hiện ở hai IP khác nước trong vài giây là
 * phiên bị đánh cắp. Bot chạy trên Render nên IP thật là datacenter US; nếu request
 * enroll quest ẩn lại đi proxy Indonesia thì đúng mẫu đó, token chết ngay sau khi nhận.
 */

const IP_URL = 'https://ipwho.is/';

interface Cached {
	ip: string;
	country: string | null;
	at: number;
}

let cached: Cached | null = null;
const TTL_MS = 30 * 60 * 1000;

/** IP và nước hiện tại của kết nối trực tiếp, cache 30 phút. */
export async function directEgress(): Promise<{ ip: string | null; country: string | null }> {
	if (cached && Date.now() - cached.at < TTL_MS) return { ip: cached.ip, country: cached.country };
	try {
		const res = await fetch(IP_URL, { signal: AbortSignal.timeout(8000) });
		const body = (await res.json()) as { ip?: string; country_code?: string; success?: boolean };
		const ip = body.ip?.trim() ?? null;
		const country = body.success === false ? null : (body.country_code?.toUpperCase() ?? null);
		if (ip) cached = { ip, country, at: Date.now() };
		return { ip, country };
	} catch {
		return { ip: cached?.ip ?? null, country: cached?.country ?? null };
	}
}

/** Được phép đổi nước để nhận quest ẩn hay không (mặc định không). */
export function allowRegionHop(): boolean {
	return process.env.ALLOW_REGION_HOP === '1';
}
