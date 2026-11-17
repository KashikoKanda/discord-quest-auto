import WebSocket from 'ws';
import { logger } from '../core/logger';
import type { GatewayInteraction } from './interface';
import { markTokenRejected } from './health';

const URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RECONNECT: 7, INVALID: 9, HELLO: 10, ACK: 11 } as const;

export type InteractionHandler = (interaction: GatewayInteraction) => void;

interface Session {
	token: string;
	intents: number;
	seq: number | null;
	sessionId: string | null;
	resumeUrl: string | null;
	socket: WebSocket | null;
	heartbeat: NodeJS.Timeout | null;
	acked: boolean;
	closed: boolean;
	reconnects: number;
	/** Tag của bot khi gateway sẵn sàng, dùng cho /health. */
	tag: string | null;
}

const session: Session = {
	token: '',
	intents: 0,
	seq: null,
	sessionId: null,
	resumeUrl: null,
	socket: null,
	heartbeat: null,
	acked: true,
	closed: false,
	reconnects: 0,
	tag: null,
};

let onInteraction: InteractionHandler = () => {};

function send(payload: Record<string, unknown>): void {
	if (session.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify(payload));
}

function stopHeartbeat(): void {
	if (session.heartbeat) clearInterval(session.heartbeat);
	session.heartbeat = null;
}

function startHeartbeat(intervalMs: number): void {
	stopHeartbeat();
	session.acked = true;
	session.heartbeat = setInterval(() => {
		if (!session.acked) {
			logger.warn('Gateway không trả lời heartbeat, kết nối lại.');
			session.socket?.terminate();
			return;
		}
		session.acked = false;
		send({ op: OP.HEARTBEAT, d: session.seq });
	}, intervalMs);
}

function identify(): void {
	send({
		op: OP.IDENTIFY,
		d: {
			token: `Bot ${session.token}`,
			intents: session.intents,
			properties: { os: process.platform, browser: 'quest-bot', device: 'quest-bot' },
		},
	});
}

function resume(): void {
	send({
		op: 6,
		d: { token: `Bot ${session.token}`, session_id: session.sessionId, seq: session.seq },
	});
}

function handleDispatch(type: string, data: Record<string, any>): void {
	if (type === 'READY') {
		session.sessionId = data.session_id ?? null;
		session.resumeUrl = data.resume_gateway_url ?? null;
		session.reconnects = 0;
		const tag = data.user?.username ? `${data.user.username}#${data.user.discriminator ?? '0'}` : 'bot';
		session.tag = tag;
		logger.success(`Gateway sẵn sàng · ${tag} · ${data.guilds?.length ?? 0} server`);
		return;
	}
	if (type === 'RESUMED') {
		logger.success('Gateway đã phục hồi phiên cũ.');
		return;
	}
	if (type === 'INTERACTION_CREATE') {
		onInteraction(data as GatewayInteraction);
	}
}

function connect(): void {
	if (session.closed) return;

	const url = session.sessionId && session.resumeUrl ? `${session.resumeUrl}/?v=10&encoding=json` : URL;
	const socket = new WebSocket(url);
	session.socket = socket;

	socket.on('open', () => {
		if (session.sessionId) resume();
	});

	socket.on('message', (raw: WebSocket.RawData) => {
		let payload: { op: number; t?: string; s?: number; d?: any };
		try {
			payload = JSON.parse(raw.toString());
		} catch {
			return;
		}

		if (payload.s !== null && payload.s !== undefined) session.seq = payload.s;

		switch (payload.op) {
			case OP.HELLO:
				startHeartbeat(payload.d.heartbeat_interval);
				if (!session.sessionId) identify();
				break;
			case OP.HEARTBEAT:
				send({ op: OP.HEARTBEAT, d: session.seq });
				break;
			case OP.ACK:
				session.acked = true;
				break;
			case OP.RECONNECT:
				socket.close(4000);
				break;
			case OP.INVALID:
				session.sessionId = null;
				session.seq = null;
				setTimeout(identify, 3000);
				break;
			case OP.DISPATCH:
				if (payload.t) handleDispatch(payload.t, payload.d ?? {});
				break;
			default:
				break;
		}
	});

	socket.on('error', (error: Error) => {
		logger.warn(`Gateway lỗi: ${error.message}`);
	});

	socket.on('close', (code: number) => {
		stopHeartbeat();
		session.socket = null;
		if (session.closed) return;

		if (code === 4004) {
			logger.error('Discord từ chối token bot (4004). Token đã bị thu hồi hoặc gõ sai.');
			markTokenRejected(session.token, 'gateway close 4004 (unauthorized)');
			process.exit(78);
		}

		session.reconnects += 1;
		const wait = Math.min(30000, 1000 * 2 ** Math.min(session.reconnects, 5));
		logger.warn(`Gateway đóng (mã ${code}), kết nối lại sau ${Math.round(wait / 1000)}s.`);
		setTimeout(connect, wait);
	});
}

export function startGateway(token: string, intents: number, handler: InteractionHandler): void {
	session.token = token;
	session.intents = intents;
	session.closed = false;
	onInteraction = handler;
	connect();
}

/** Trạng thái kết nối, cho endpoint /health của chế độ giữ thức. */
export function gatewayStatus(): { connected: boolean; tag: string | null } {
	return { connected: session.socket?.readyState === 1, tag: session.tag };
}

export function stopGateway(): void {
	session.closed = true;
	stopHeartbeat();
	session.socket?.close(1000);
	session.socket = null;
}
