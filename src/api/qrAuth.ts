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

async function exchangeTicket(ticket: string, userAgent: string): Promise<string> {
	const res = await fetch(LOGIN_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'User-Agent': userAgent,
			Origin: 'https://discord.com',
			Referer: 'https://discord.com/',
		},
		body: JSON.stringify({ ticket }),
		signal: AbortSignal.timeout(20_000),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`Đổi ticket thất bại (${res.status}): ${text.slice(0, 120)}`);
	const parsed = JSON.parse(text) as { encrypted_token?: string };
	if (!parsed.encrypted_token) throw new Error('Discord không trả token');
	return parsed.encrypted_token;
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
						const encryptedToken = await exchangeTicket(ticket, userAgent);
						resolveToken(decrypt(privateKey, encryptedToken).toString('utf8'));
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
	return { fingerprint, png, wait: tokenWait, cancel: stop };
}

/** Vẽ QR dạng chữ để in thẳng trong terminal. */
export async function qrToTerminal(fingerprint: string): Promise<string> {
	return QRCode.toString(`https://discord.com/ra/${fingerprint}`, { type: 'terminal', small: true });
}
