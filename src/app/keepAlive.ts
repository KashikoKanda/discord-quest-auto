/**
 * Giữ bot thức trên gói miễn phí của Render.
 *
 * Gói free chỉ có web service, không có background worker, và web service ngủ sau
 * 15 phút không có request. Module này mở một cổng HTTP nhỏ trả /health rồi tự gọi
 * chính nó mỗi 3 phút, đủ để Render coi là đang có truy cập.
 *
 * Chỉ bật khi có PORT trong môi trường, nên CLI ở máy nhà không mở cổng nào.
 */

import http from 'node:http';
import https from 'node:https';
import { captchaPage, submitManualTicket } from '../api/captcha';

const PING_EVERY_MS = 3 * 60 * 1000;

export interface KeepAliveOptions {
	/** Trạng thái gateway để /health nói được bot có thật sự kết nối Discord không. */
	status: () => { connected: boolean; tag: string | null };
}

export function startKeepAlive(options: KeepAliveOptions): { stop: () => void } | null {
	const port = Number(process.env.PORT ?? '');
	if (!Number.isFinite(port) || port <= 0) return null;

	const externalUrl = process.env.RENDER_EXTERNAL_URL?.trim();
	const startedAt = Date.now();

	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', `http://localhost:${port}`);

		// Trang cho người dùng tự giải captcha Discord.
		if (req.method === 'GET' && url.pathname === '/captcha') {
			const html = captchaPage(url.searchParams.get('id') ?? '');
			res.writeHead(html ? 200 : 410, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(
				html ??
					'<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;background:#1e1f22;color:#dbdee1;display:grid;place-items:center;height:100vh;margin:0">Vé đã hết hạn, chạy /login lại trong Discord.</body>',
			);
			return;
		}

		if (req.method === 'POST' && url.pathname === '/captcha') {
			let raw = '';
			req.on('data', (chunk) => {
				raw += chunk;
				if (raw.length > 20_000) req.destroy();
			});
			req.on('end', () => {
				let ok = false;
				try {
					const body = JSON.parse(raw) as { id?: string; token?: string };
					ok = Boolean(body.id && body.token && submitManualTicket(body.id, body.token));
				} catch {
					ok = false;
				}
				res.writeHead(ok ? 200 : 410, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ ok }));
			});
			return;
		}

		if (url.pathname === '/health' || url.pathname === '/' || url.pathname === '/healthz') {
			const gateway = options.status();
			const body = {
				status: gateway.connected ? 'alive' : 'starting',
				tag: gateway.tag,
				uptime: Math.round(process.uptime()),
				since: new Date(startedAt).toISOString(),
			};
			res.writeHead(gateway.connected ? 200 : 503, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(body));
			return;
		}
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end('Not Found');
	});

	server.listen(port, () => {
		console.log(`[keepalive] nghe cổng ${port}${externalUrl ? ` · ${externalUrl}` : ''}`);
	});

	const timer = setInterval(() => {
		// Gọi nội bộ để chắc chắn process còn phản hồi, và gọi URL công khai để Render
		// thấy có traffic từ ngoài vào.
		http.get(`http://127.0.0.1:${port}/health`, () => undefined).on('error', () => undefined);
		if (externalUrl) {
			https.get(`${externalUrl.replace(/\/$/, '')}/health`, () => undefined).on('error', () => undefined);
		}
	}, PING_EVERY_MS);
	timer.unref?.();

	return {
		stop: () => {
			clearInterval(timer);
			server.close();
		},
	};
}
