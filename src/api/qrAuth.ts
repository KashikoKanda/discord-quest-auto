/**
 * Đăng nhập bằng mã QR của Discord (remote auth, luồng desktop).
 *
 * Người dùng mở app Discord trên điện thoại, quét mã, bấm xác nhận. Discord trả
 * ticket qua WebSocket, đổi ticket lấy token đã mã hoá bằng khoá công khai của
 * phiên, giải bằng khoá riêng. Không ai phải nhìn thấy hay dán token.
 *
 * Tham chiếu: docs.discord.food/remote-authentication/desktop
 */

import crypto from 'node:crypto';
import WebSocket from 'ws';
import QRCode from 'qrcode';

const WS_URL = 'wss://remote-auth-gateway.discord.gg/?v=2';
const LOGIN_URL = 'https://discord.com/api/v9/users/@me/remote-auth/login';
const TTL_MS = 2 * 60 * 1000;

export interface QrHandlers {
	/** Đã có fingerprint, vẽ được mã. */
	onReady?: (fingerprint: string, png: Buffer) => void;
	/** Điện thoại đã quét, đang chờ bấm xác nhận. */
	onScanned?: (username?: string) => void;
}

export interface QrLogin {
	fingerprint: string;
	/** IP mà phiên QR đang đi ra (để biết vì sao Discord đòi captcha). */
	ip: string | null;
	/** Đi trực tiếp hay qua proxy nào. */
	ipNote: string;
	/** Ảnh QR dạng PNG. */
	png: Buffer;
	/** Token khi người dùng xác nhận xong. */
	wait: Promise<string>;
	/** Huỷ phiên (đóng WebSocket). */
	cancel: () => void;
}

function decrypt(privateKey: crypto.KeyObject, encryptedB64: string): Buffer {
	return crypto.privateDecrypt(
		{ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
		Buffer.from(encryptedB64, 'base64'),
	);
}

function toBase64Url(buffer: Buffer): string {
	return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function qrPng(fingerprint: string): Promise<Buffer> {
	return QRCode.toBuffer(`https://discord.com/ra/${fingerprint}`, {
		type: 'png',
		margin: 1,
		width: 320,
		errorCorrectionLevel: 'M',
	});
}

/** Header giống client web thật: Discord chấm điểm request trần là bot và đòi captcha. */
function browserHeaders(userAgent: string, chrome: string): Record<string, string> {
	const superProps = Buffer.from(
		JSON.stringify({
			os: 'Windows',
			browser: 'Discord Client',
			release_channel: 'stable',
			client_version: '1.0.9236',
			os_version: '10.0.22631',
			os_arch: 'x64',
			app_arch: 'x64',
			system_locale: 'en-US',
			has_client_mods: false,
			client_launch_id: crypto.randomUUID(),
			browser_user_agent: userAgent,
			browser_version: chrome,
			os_sdk_version: '22631',
			client_build_number: 539951,
			native_build_number: 81687,
			client_event_source: null,
			launch_signature: crypto.randomUUID(),
			client_heartbeat_session_id: crypto.randomUUID(),
			client_app_state: 'focused',
		}),
	).toString('base64');

	return {
		'Content-Type': 'application/json',
		'User-Agent': userAgent,
		Origin: 'https://discord.com',
		Referer: 'https://discord.com/',
		'Accept-Language': 'en-US,en;q=0.9',
		'x-super-properties': superProps,
		'x-discord-locale': 'en-US',
		'x-discord-timezone': 'Asia/Saigon',
		'sec-ch-ua': `"Chromium";v="${chrome}", "Not(A:Brand";v="24"`,
		'sec-ch-ua-mobile': '?0',
		'sec-ch-ua-platform': '"Windows"',
		'Sec-Fetch-Dest': 'empty',
		'Sec-Fetch-Mode': 'cors',
		'Sec-Fetch-Site': 'same-origin',
	};
}

interface ExchangeOutcome {
	token?: string;
	error?: string;
	captcha?: boolean;
}

/**
 * Đổi ticket lấy token. Discord hay đòi captcha khi request tới từ IP máy chủ,
 * nên thử lần lượt vài kiểu vân tay trình duyệt rồi tới proxy nếu có.
 */
async function exchangeTicket(ticket: string): Promise<ExchangeOutcome> {
	const { loadProxies } = await import('../core/proxies');
	const variants = [
		{
			ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36',
			chrome: '158',
		},
		{
			ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
			chrome: '157',
		},
		{
			ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36',
			chrome: '158',
		},
	];

	const proxies = await loadProxies().catch(() => []);
	const attempts: { ua: string; chrome: string; proxy?: string }[] = variants.map((variant) => ({ ...variant }));
	for (const proxy of proxies.slice(0, 3)) {
		attempts.push({ ...variants[0], proxy: proxy.url });
	}

	let captcha = false;
	let lastError = '';

	for (const [index, attempt] of attempts.entries()) {
		try {
			const init: Record<string, unknown> = {
				method: 'POST',
				headers: browserHeaders(attempt.ua, attempt.chrome),
				body: JSON.stringify({ ticket }),
				signal: AbortSignal.timeout(20_000),
			};

			let res: Awaited<ReturnType<typeof fetch>>;
			if (attempt.proxy) {
				const { ProxyAgent, fetch: undiciFetch } = await import('undici');
				(init as any).dispatcher = new ProxyAgent(attempt.proxy);
				res = (await undiciFetch(LOGIN_URL, init as any)) as unknown as Response;
			} else {
				res = await fetch(LOGIN_URL, init as any);
			}

			const text = await res.text();
			if (res.ok) {
				const parsed = JSON.parse(text) as { encrypted_token?: string };
				if (parsed.encrypted_token) return { token: parsed.encrypted_token };
				lastError = 'Discord không trả token';
				continue;
			}

			if (text.includes('captcha-required') || text.includes('captcha_key')) {
				captcha = true;
				lastError = 'Discord đòi captcha';
				continue;
			}

			if (text.includes('Invalid remote authentication ticket') || text.includes('20042')) {
				return { error: 'Mã QR đã hết hiệu lực hoặc đã dùng, chạy lại /qr để lấy mã mới.' };
			}

			lastError = `${res.status}: ${text.slice(0, 120)}`;
		} catch (error) {
			lastError = (error as Error).message;
		}

		if (index === 0 && attempts.length > 1) {
			// Đổi vân tay rồi thử lại ngay, không cần chờ.
		}
	}

	if (captcha && proxies.length === 0) {
		return {
			error: 'Discord chặn IP máy chủ này bằng captcha khi đổi mã QR. Đặt PROXY_LIST_URL (proxy dân dụng) rồi thử lại, hoặc dùng /link để dán token.',
			captcha: true,
		};
	}
	return { error: lastError || 'Không đổi được mã QR thành token', captcha };
}

/** IP mà máy này đi ra internet, hoặc null nếu không biết. */
async function egressIp(proxyUrl?: string): Promise<string | null> {
	try {
		const init: Record<string, unknown> = { signal: AbortSignal.timeout(6000) };
		if (proxyUrl) {
			const { ProxyAgent, fetch: undiciFetch } = await import('undici');
			(init as any).dispatcher = new ProxyAgent(proxyUrl);
			const res = (await undiciFetch('https://api.ipify.org?format=json', init as any)) as unknown as Response;
			return res.ok ? (((await res.json()) as { ip?: string }).ip ?? null) : null;
		}
		const res = await fetch('https://api.ipify.org?format=json', init as any);
		return res.ok ? (((await res.json()) as { ip?: string }).ip ?? null) : null;
	} catch {
		return null;
	}
}

/** Mở một phiên QR và chờ token. */
export async function startQrLogin(
	handlers: QrHandlers = {},
	userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36',
): Promise<QrLogin> {
	const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
	const encodedPublicKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

	const ws = new WebSocket(WS_URL, {
		origin: 'https://discord.com',
		headers: {
			'User-Agent': userAgent,
			'Accept-Language': 'en-US,en;q=0.9',
			'sec-ch-ua': '"Chromium";v="138", "Not(A:Brand";v="24"',
			'sec-ch-ua-mobile': '?0',
			'sec-ch-ua-platform': '"Windows"',
		},
		handshakeTimeout: 15_000,
	});

	let heartbeat: NodeJS.Timeout | null = null;
	let timer: NodeJS.Timeout | null = null;
	let closed = false;

	const stop = () => {
		if (closed) return;
		closed = true;
		if (heartbeat) clearInterval(heartbeat);
		if (timer) clearTimeout(timer);
		heartbeat = null;
		timer = null;
		try {
			ws.close();
		} catch {
			/* socket đã đóng */
		}
	};

	let resolveToken: (token: string) => void = () => undefined;
	let rejectToken: (error: Error) => void = () => undefined;
	const tokenWait = new Promise<string>((resolve, reject) => {
		resolveToken = resolve;
		rejectToken = reject;
	});
	// Giữ một nhánh bắt lỗi riêng để phiên hết hạn không thành unhandled rejection
	// khi phía gọi chỉ đang chờ ảnh QR.
	tokenWait.catch(() => undefined);

	const ready = new Promise<{ fingerprint: string; png: Buffer }>((resolve, reject) => {
		let done = false;
		const fail = (error: Error) => {
			if (done) return;
			done = true;
			reject(error);
			rejectToken(error);
			stop();
		};

		ws.on('message', async (raw: WebSocket.RawData) => {
			let message: Record<string, any>;
			try {
				message = JSON.parse(raw.toString());
			} catch {
				return;
			}

			switch (message.op) {
				case 'hello': {
					// Mở kết nối xong mới gửi init; giữ nhịp tim theo heartbeat_interval.
					heartbeat = setInterval(
						() => {
							try {
								ws.send(JSON.stringify({ op: 'heartbeat' }));
							} catch {
								/* socket đóng */
							}
						},
						Number(message.heartbeat_interval) || 41_250,
					);
					ws.send(JSON.stringify({ op: 'init', encoded_public_key: encodedPublicKey }));
					timer = setTimeout(() => fail(new Error('Hết thời gian chờ quét mã (2 phút)')), TTL_MS);
					break;
				}

				case 'nonce_proof': {
					try {
						const nonce = decrypt(privateKey, String(message.encrypted_nonce ?? ''));
						ws.send(JSON.stringify({ op: 'nonce_proof', nonce: toBase64Url(nonce) }));
					} catch (error) {
						fail(new Error(`Không giải được nonce: ${(error as Error).message}`));
					}
					break;
				}

				case 'pending_remote_init': {
					const fingerprint = String(message.fingerprint ?? '');
					if (!fingerprint) {
						fail(new Error('Discord không trả fingerprint'));
						break;
					}
					const png = await qrPng(fingerprint);
					if (!done) {
						done = true;
						resolve({ fingerprint, png });
					}
					handlers.onReady?.(fingerprint, png);
					break;
				}

				case 'pending_ticket': {
					let username: string | undefined;
					try {
						const parts = decrypt(privateKey, String(message.encrypted_user_payload ?? ''))
							.toString('utf8')
							.split(':');
						if (parts.length >= 4) username = parts[3];
					} catch {
						/* chỉ là thông tin phụ */
					}
					handlers.onScanned?.(username);
					break;
				}

				case 'pending_login': {
					try {
						const ticket = String(message.ticket ?? '');
						if (!ticket) throw new Error('Thiếu ticket');
						const outcome = await exchangeTicket(ticket);
						if (outcome.token) {
							resolveToken(decrypt(privateKey, outcome.token).toString('utf8'));
						} else {
							rejectToken(new Error(outcome.error ?? 'Không đổi được mã QR thành token'));
						}
					} catch (error) {
						rejectToken(error as Error);
					}
					stop();
					break;
				}

				case 'cancel': {
					fail(new Error('Điện thoại đã huỷ đăng nhập'));
					break;
				}

				default:
					break;
			}
		});

		ws.on('error', (error: Error) => fail(new Error(`Không kết nối được remote-auth-gateway: ${error.message}`)));
		ws.on('close', () => {
			if (!done) fail(new Error('Kết nối remote-auth-gateway đóng sớm'));
			else rejectToken(new Error('Phiên QR đã đóng'));
			stop();
		});
	});

	const { fingerprint, png } = await ready;

	// Ghi lại IP đi ra để hiển thị cùng mã QR: captcha của Discord phụ thuộc IP.
	const { loadProxies } = await import('../core/proxies');
	const proxies = await loadProxies().catch(() => []);
	const direct = await egressIp();
	let ip = direct;
	let ipNote = 'trực tiếp';
	if (!ip && proxies[0]) {
		ip = await egressIp(proxies[0].url);
		if (ip) ipNote = proxies[0].label;
	}

	return { fingerprint, png, ip, ipNote, wait: tokenWait, cancel: stop };
}

/** Vẽ QR dạng chữ để in thẳng trong terminal. */
export async function qrToTerminal(fingerprint: string): Promise<string> {
	return QRCode.toString(`https://discord.com/ra/${fingerprint}`, { type: 'terminal', small: true });
}
