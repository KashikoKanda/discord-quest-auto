/**
 * Thử xem OAuth2 của app bot có gọi được API quest hay không.
 *
 * Mục đích duy nhất là trả lời một câu hỏi kỹ thuật: access token lấy từ OAuth2
 * (scope identify + guilds) có được Discord cho đọc quest, enroll và claim không.
 * Nếu được thì người dùng chỉ cần bấm "Authorize" thay vì dán token; nếu không thì
 * không có đường nào khác ngoài token người dùng.
 *
 * Không lưu token: chỉ giữ trong RAM vài phút để hiện kết quả, in dạng vân tay.
 */

import { randomBytes } from 'node:crypto';

const AUTHORIZE = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/v10/oauth2/token';
const API = 'https://discord.com/api/v10';

interface ProbeResult {
	at: number;
	username: string;
	userId: string;
	tokenPrint: string;
	checks: { label: string; status: number; note: string }[];
}

const results = new Map<string, ProbeResult>();

function clientId(): string {
	return (process.env.DISCORD_CLIENT_ID ?? '1569031535363887175').trim();
}

function clientSecret(): string {
	return (process.env.DISCORD_CLIENT_SECRET ?? '').trim();
}

export function redirectUri(base: string): string {
	return `${base.replace(/\/$/, '')}/oauth/callback`;
}

/** Link để owner bấm authorize; state ngắn để đối chiếu lúc callback. */
export function authorizeUrl(base: string): { url: string; state: string } {
	const state = randomBytes(8).toString('hex');
	const params = new URLSearchParams({
		client_id: clientId(),
		response_type: 'code',
		scope: 'identify guilds',
		redirect_uri: redirectUri(base),
		state,
		prompt: 'consent',
	});
	return { url: `${AUTHORIZE}?${params.toString()}`, state };
}

async function probe(path: string, token: string): Promise<{ status: number; note: string }> {
	try {
		const res = await fetch(`${API}${path}`, {
			headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'DiscordQuestAuto/1.0' },
			signal: AbortSignal.timeout(12_000),
		});
		const text = await res.text();
		let note = text.slice(0, 160);
		try {
			const json = JSON.parse(text) as Record<string, unknown>;
			if (Array.isArray(json.quests)) note = `${json.quests.length} quest`;
			else if (json.message) note = String(json.message);
			else if (json.username) note = String(json.username);
		} catch {
			/* giữ nguyên text thô */
		}
		return { status: res.status, note };
	} catch (error) {
		return { status: 0, note: (error as Error).message };
	}
}

/** Đổi code lấy token rồi thử đúng những endpoint mà quest cần. */
export async function exchangeAndProbe(base: string, code: string): Promise<ProbeResult | { error: string }> {
	const secret = clientSecret();
	if (!secret) return { error: 'Thiếu DISCORD_CLIENT_SECRET trên service' };

	const body = new URLSearchParams({
		client_id: clientId(),
		client_secret: secret,
		grant_type: 'authorization_code',
		code,
		redirect_uri: redirectUri(base),
	});

	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body,
		signal: AbortSignal.timeout(15_000),
	}).catch((error: Error) => ({ ok: false, status: 0, text: async () => error.message }) as never);

	const text = await (res as Response).text();
	if (!(res as Response).ok) return { error: `Đổi code thất bại ${(res as Response).status}: ${text.slice(0, 200)}` };

	const token = (JSON.parse(text) as { access_token?: string }).access_token ?? '';
	if (!token) return { error: 'Discord không trả access_token' };

	const me = await probe('/users/@me', token);
	let username = '';
	let userId = '';
	if (me.status === 200) {
		const res2 = await fetch(`${API}/users/@me`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(10_000),
		});
		const profile = (await res2.json().catch(() => ({}))) as { username?: string; id?: string };
		username = profile.username ?? '';
		userId = profile.id ?? '';
	}

	const checks = [
		{ label: 'GET /users/@me', ...me },
		{ label: 'GET /quests/@me', ...(await probe('/quests/@me', token)) },
		{ label: 'GET /quests/@me/claim', ...(await probe('/quests/@me/claim', token)) },
		{
			label: 'GET /users/@me/virtual-currency/balance',
			...(await probe('/users/@me/virtual-currency/balance', token)),
		},
	];

	const result: ProbeResult = {
		at: Date.now(),
		username,
		userId,
		tokenPrint: `${token.slice(0, 6)}…<đã che>`,
		checks,
	};
	results.set(userId || 'anon', result);
	return result;
}

/** Trang kết quả, chỉ để đọc bằng mắt. */
export function resultPage(result: ProbeResult): string {
	const rows = result.checks
		.map((check) => {
			const ok = check.status === 200 || check.status === 204;
			const color = ok ? '#57f287' : '#ed4245';
			return `<tr><td>${check.label}</td><td style="color:${color}">${check.status || 'lỗi mạng'}</td><td>${check.note.replace(/</g, '&lt;')}</td></tr>`;
		})
		.join('');
	return `<!doctype html><meta charset="utf-8"><title>OAuth2 probe</title>
<body style="font:15px system-ui;background:#14151a;color:#e6e8ee;padding:24px">
<h1 style="font-size:19px">OAuth2 của app bot gọi được gì</h1>
<p>${result.username ? `Tài khoản ${result.username} (${result.userId})` : 'Không đọc được profile'} · token ${result.tokenPrint}</p>
<table cellpadding="8" style="border-collapse:collapse;background:#1b1d24;border-radius:8px">${rows}</table>
<p style="opacity:.7;margin-top:16px">200 = gọi được · 401/403 = OAuth2 không có quyền đó</p>
</body>`;
}
