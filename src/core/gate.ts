/**
 * Cửa van cho mọi request ra Discord.
 *
 * Mục tiêu khi chạy số lượng lớn tài khoản cùng lúc:
 *   - không dồn quá nhiều request lên cùng một IP ra (bị coi là spam),
 *   - giãn cách request trên mỗi IP,
 *   - khi bị 429 thì cả IP đó nghỉ một lúc thay vì mỗi tài khoản tự đập tiếp.
 *
 * Khoá là "IP ra": 'direct' cho kết nối thẳng, hoặc URL proxy. Nhờ vậy giới hạn
 * tính theo từng exit, đúng thứ Discord nhìn thấy.
 */

interface GateOptions {
	concurrency: number;
	minGapMs: number;
}

interface Slot {
	active: number;
	lastAt: number;
	cooldownUntil: number;
	queue: (() => void)[];
}

const slots = new Map<string, Slot>();

function num(value: string | undefined, fallback: number): number {
	const parsed = Number(value ?? '');
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Giới hạn cho kết nối thẳng và cho proxy, đọc từ biến môi trường. */
export function gateOptions(key: string): GateOptions {
	const isProxy = key !== 'direct';
	return isProxy
		? {
				concurrency: Math.max(1, num(process.env.GATE_PROXY_CONCURRENCY, 2)),
				minGapMs: num(process.env.GATE_PROXY_MIN_GAP_MS, 800),
			}
		: {
				concurrency: Math.max(1, num(process.env.GATE_DIRECT_CONCURRENCY, 4)),
				minGapMs: num(process.env.GATE_DIRECT_MIN_GAP_MS, 250),
			};
}

function slotFor(key: string): Slot {
	let slot = slots.get(key);
	if (!slot) {
		slot = { active: 0, lastAt: 0, cooldownUntil: 0, queue: [] };
		slots.set(key, slot);
	}
	return slot;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Xin quyền đi một request trên khoá này. Trả về hàm nhả chỗ, luôn gọi trong finally.
 */
export async function gateEnter(key = 'direct'): Promise<() => void> {
	const slot = slotFor(key);
	const { concurrency, minGapMs } = gateOptions(key);

	// Chờ tới lượt: hết cooldown, còn chỗ, và đủ giãn cách so với request trước.
	for (;;) {
		const now = Date.now();
		if (now < slot.cooldownUntil) {
			await sleep(slot.cooldownUntil - now);
			continue;
		}
		if (slot.active >= concurrency) {
			await new Promise<void>((resolve) => slot.queue.push(resolve));
			continue;
		}
		const gap = minGapMs - (now - slot.lastAt);
		if (gap > 0) {
			await sleep(gap);
			continue;
		}
		slot.active += 1;
		slot.lastAt = Date.now();
		break;
	}

	let released = false;
	return () => {
		if (released) return;
		released = true;
		slot.active = Math.max(0, slot.active - 1);
		const next = slot.queue.shift();
		if (next) next();
	};
}

/** Cho cả khoá nghỉ, dùng khi Discord trả 429 hoặc lỗi hàng loạt. */
export function gatePenalize(key: string, ms: number): void {
	const slot = slotFor(key);
	slot.cooldownUntil = Math.max(slot.cooldownUntil, Date.now() + Math.max(0, ms));
}

export function gateSnapshot(): { key: string; active: number; cooldownMs: number; waiting: number }[] {
	const now = Date.now();
	return [...slots.entries()].map(([key, slot]) => ({
		key,
		active: slot.active,
		cooldownMs: Math.max(0, slot.cooldownUntil - now),
		waiting: slot.queue.length,
	}));
}

/** Bọc một việc có gọi mạng bằng cửa van, tự nhả chỗ kể cả khi lỗi. */
export async function withGate<T>(key: string, work: () => Promise<T>): Promise<T> {
	const release = await gateEnter(key);
	try {
		return await work();
	} finally {
		release();
	}
}
