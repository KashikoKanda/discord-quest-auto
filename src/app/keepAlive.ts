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
