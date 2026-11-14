import { API_DELAY_MS } from './constants';
import { discordFetch } from '../api/client';
import { addLog, getGlobalState, rnd, sleep } from './state';

const MAX_RETRIES = 3;
const RETRYABLE = new Set([429, 500, 502, 503, 504, 408]);

export interface QueueRequest {
	url: string;
	body: unknown;
	resolve: (value: any) => void;
	reject: (reason: any) => void;
	attempts: number;
	token: string;
	tokenId: string;
}

export function enqueueApiCall<T = any>(tokenId: string, url: string, body: unknown): Promise<T> {
	const state = getGlobalState().get(tokenId);
	if (!state) {
		return Promise.reject(new Error('Token chưa đăng ký'));
	}

	return new Promise((resolve, reject) => {
		state.apiQueue.push({ url, body, resolve, reject, attempts: 0, token: state.token, tokenId });
		processTokenQueue(tokenId);
	});
}

export async function processTokenQueue(tokenId: string): Promise<void> {
	const state = getGlobalState().get(tokenId);
	if (!state || state.queueProcessing || state.apiQueue.length === 0) return;
	state.queueProcessing = true;

	while (state.apiQueue.length > 0) {
		const req = state.apiQueue.shift();
		if (!req) break;

		try {
			const res = await discordFetch(
				req.token,
				req.url,
				{ method: 'POST', body: JSON.stringify(req.body) },
				req.tokenId,
			);

			if (res.status === 429) {
				const retryAfter = parseInt(res.headers.get('retry-after') || '5');
				if (req.attempts < MAX_RETRIES) {
					req.attempts++;
					const delay = (retryAfter + Math.pow(2, req.attempts)) * 1000 + rnd(200, 800);
					addLog(
						tokenId,
						'warn',
						`Rate limited, retry ${req.attempts}/${MAX_RETRIES} sau ${(delay / 1000).toFixed(1)}s`,
					);
					await sleep(delay);
					state.apiQueue.unshift(req);
				} else {
					req.reject(new Error(`Rate limited after ${MAX_RETRIES} retries`));
				}
			} else if (RETRYABLE.has(res.status)) {
				if (req.attempts < MAX_RETRIES) {
					req.attempts++;
					const delay = Math.pow(2, req.attempts) * 1000 + rnd(200, 800);
					await sleep(delay);
					state.apiQueue.unshift(req);
				} else {
					req.reject(new Error(`Server error ${res.status} after ${MAX_RETRIES} retries`));
				}
			} else {
				let data: any = null;
				try {
					data = await res.json();
				} catch {
					/* empty body */
				}
				req.resolve({ status: res.status, ok: res.ok, data });
			}
		} catch (err) {
			req.reject(err);
		}

		await sleep(rnd(API_DELAY_MS[0], API_DELAY_MS[1]));
	}

	state.queueProcessing = false;
}
