/**
 * Giải captcha khi Discord chặn bước đổi ticket.
 *
 * Discord trả 400 kèm captcha_sitekey (hCaptcha). Có hai đường:
 *   - Tự giải bằng dịch vụ (CapSolver / 2Captcha) nếu có key.
 *   - Đưa link cho người dùng tự giải: bot mở một trang nhỏ trên chính web service,
 *     người dùng tick captcha, token được gửi về và dùng ngay cho lần thử lại.
 *
 * Vé tự giải sống 5 phút; sau đó coi như bỏ.
 */

const TICKET_TTL_MS = 5 * 60 * 1000;
const DISCORD_ORIGIN = 'https://discord.com';

export interface CaptchaChallenge {
	sitekey: string;
	/** Tham số hCaptcha Discord gửi kèm, phải chuyển lại khi giải. */
	rqdata?: string;
	rqtoken?: string;
	/** Discord cần gửi lại y hệt khi nộp token. */
	sessionId?: string;
}

/** Đọc phần captcha trong body lỗi của Discord. */
export function parseCaptcha(body: string): CaptchaChallenge | null {
	try {
		const data = JSON.parse(body) as {
			captcha_sitekey?: string;
			captcha_rqdata?: string;
			captcha_rqtoken?: string;
			captcha_session_id?: string;
		};
		if (!data.captcha_sitekey) return null;
		return {
			sitekey: data.captcha_sitekey,
			rqdata: data.captcha_rqdata,
			rqtoken: data.captcha_rqtoken,
			sessionId: data.captcha_session_id,
		};
	} catch {
		const sitekey = body.match(/"captcha_sitekey"\s*:\s*"([^"]+)"/)?.[1];
		if (!sitekey) return null;
		const rqdata = body.match(/"captcha_rqdata"\s*:\s*"([^"]*)"/)?.[1];
		const rqtoken = body.match(/"captcha_rqtoken"\s*:\s*"([^"]*)"/)?.[1];
		const sessionId = body.match(/"captcha_session_id"\s*:\s*"([^"]*)"/)?.[1];
		return { sitekey, rqdata, rqtoken, sessionId };
	}
}

/** Dịch vụ giải tự động đang có key hay không. */
export function solverService(): 'capsolver' | '2captcha' | null {
	if (process.env.CAPSOLVER_API_KEY?.trim()) return 'capsolver';
	if (process.env.TWOCAPTCHA_API_KEY?.trim()) return '2captcha';
	return null;
}

async function solveWithCapsolver(challenge: CaptchaChallenge, key: string): Promise<string> {
	const task: Record<string, unknown> = {
		type: 'HCaptchaTaskProxyLess',
		websiteURL: DISCORD_ORIGIN,
		websiteKey: challenge.sitekey,
	};
	// hCaptcha của Discord là loại enterprise, cần gửi kèm payload riêng.
	if (challenge.rqdata) task.enterprisePayload = { rqdata: challenge.rqdata };
	if (challenge.rqtoken) task.userAgent = undefined;

	const create = await fetch('https://api.capsolver.com/createTask', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ clientKey: key, task }),
		signal: AbortSignal.timeout(30_000),
	});
	const created = (await create.json()) as { taskId?: string; errorDescription?: string };
	if (!created.taskId) throw new Error(created.errorDescription ?? 'CapSolver không nhận task');

	for (let i = 0; i < 30; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 3000));
		const res = await fetch('https://api.capsolver.com/getTaskResult', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ clientKey: key, taskId: created.taskId }),
			signal: AbortSignal.timeout(20_000),
		});
		const data = (await res.json()) as {
			status?: string;
			solution?: { gRecaptchaResponse?: string; token?: string };
			errorDescription?: string;
		};
		if (data.status === 'ready') {
			const token = data.solution?.gRecaptchaResponse ?? data.solution?.token;
			if (token) return token;
			throw new Error('CapSolver trả kết quả rỗng');
		}
		if (data.status === 'failed') throw new Error(data.errorDescription ?? 'CapSolver giải thất bại');
	}
	throw new Error('CapSolver quá thời gian chờ');
}

async function solveWith2captcha(challenge: CaptchaChallenge, key: string): Promise<string> {
	const params = new URLSearchParams({
		key,
		method: 'hcaptcha',
		sitekey: challenge.sitekey,
		pageurl: DISCORD_ORIGIN,
		json: '1',
	});
	if (challenge.rqdata) params.set('data', challenge.rqdata);

	const submit = await fetch(`https://2captcha.com/in.php?${params.toString()}`, {
		signal: AbortSignal.timeout(30_000),
	});
	const created = (await submit.json()) as { status?: number; request?: string };
	if (created.status !== 1 || !created.request) throw new Error('2Captcha không nhận task');

	for (let i = 0; i < 30; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5000));
		const poll = await fetch(
			`https://2captcha.com/res.php?key=${encodeURIComponent(key)}&action=get&id=${created.request}&json=1`,
			{ signal: AbortSignal.timeout(20_000) },
		);
		const data = (await poll.json()) as { status?: number; request?: string };
		if (data.status === 1 && data.request) return data.request;
		if (data.request && data.request !== 'CAPCHA_NOT_READY') throw new Error(`2Captcha: ${data.request}`);
	}
	throw new Error('2Captcha quá thời gian chờ');
}

export async function solveAutomatically(challenge: CaptchaChallenge): Promise<string> {
	const service = solverService();
	const capsolverKey = process.env.CAPSOLVER_API_KEY?.trim();
	const twoCaptchaKey = process.env.TWOCAPTCHA_API_KEY?.trim();
	if (service === 'capsolver' && capsolverKey) return solveWithCapsolver(challenge, capsolverKey);
	if (service === '2captcha' && twoCaptchaKey) return solveWith2captcha(challenge, twoCaptchaKey);
	throw new Error('Chưa cấu hình dịch vụ giải captcha');
}

// ─── Vé để người dùng tự giải ───────────────────────────────────────────────

interface ManualTicket {
	id: string;
	challenge: CaptchaChallenge;
	createdAt: number;
	resolve: (token: string) => void;
	reject: (error: Error) => void;
}

const tickets = new Map<string, ManualTicket>();

export function openManualTicket(challenge: CaptchaChallenge): { id: string; wait: Promise<string> } {
	const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	const wait = new Promise<string>((resolve, reject) => {
		const ticket: ManualTicket = { id, challenge, createdAt: Date.now(), resolve, reject };
		tickets.set(id, ticket);
		setTimeout(() => {
			if (tickets.delete(id)) reject(new Error('Hết 5 phút chờ giải captcha'));
		}, TICKET_TTL_MS).unref?.();
	});
	return { id, wait };
}

export function getManualTicket(id: string): ManualTicket | undefined {
	const ticket = tickets.get(id);
	if (!ticket) return undefined;
	if (Date.now() - ticket.createdAt > TICKET_TTL_MS) {
		tickets.delete(id);
		return undefined;
	}
	return ticket;
}

/** Nhận token từ trang giải captcha; true nếu vé còn sống. */
export function submitManualTicket(id: string, token: string): boolean {
	const ticket = getManualTicket(id);
	if (!ticket) return false;
	tickets.delete(id);
	ticket.resolve(token);
	return true;
}

/** Trang HTML để người dùng tick captcha. */
export function captchaPage(id: string): string | null {
	const ticket = getManualTicket(id);
	if (!ticket) return null;
	const { sitekey, rqdata, rqtoken } = ticket.challenge;

	return `<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Xác minh Discord</title>
<script src="https://js.hcaptcha.com/1/api.js" async defer></script>
<style>
 :root{color-scheme:dark}
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1e1f22;
      font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#dbdee1}
 .card{background:#2b2d31;border:1px solid #3f4147;border-radius:16px;padding:28px 24px;
       max-width:420px;text-align:center;box-shadow:0 12px 32px rgba(0,0,0,.35)}
 h1{font-size:18px;margin:0 0 6px}
 p{margin:0 0 18px;color:#a3a6aa;font-size:14px}
 #state{margin-top:14px;font-size:14px;color:#a3a6aa;min-height:20px}
 .ok{color:#57f287}
 .err{color:#ed4245}
</style></head>
<body><div class="card">
 <h1>Xác minh để hoàn tất đăng nhập</h1>
 <p>Discord yêu cầu captcha. Tick vào ô bên dưới, không cần làm gì thêm.</p>
 <div id="cap"></div>
 <div id="state"></div>
</div>
<script>
 const state = document.getElementById('state');
 function render() {
   if (!window.hcaptcha) { setTimeout(render, 300); return; }
   hcaptcha.render('cap', {
     sitekey: ${JSON.stringify(sitekey)},
     ${rqdata ? `rqdata: ${JSON.stringify(rqdata)},` : ''}
     ${rqtoken ? `rqtoken: ${JSON.stringify(rqtoken)},` : ''}
     callback: async (token) => {
       state.textContent = 'Đang gửi...';
       try {
         const res = await fetch('/captcha', {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ id: ${JSON.stringify(id)}, token }),
         });
         const data = await res.json().catch(() => ({}));
         if (res.ok && data.ok) {
           state.className = 'ok';
           state.textContent = 'Xong! Quay lại Discord.';
         } else {
           state.className = 'err';
           state.textContent = 'Vé đã hết hạn, chạy /login lại.';
         }
       } catch (e) {
         state.className = 'err';
         state.textContent = 'Không gửi được, thử lại.';
       }
     },
   });
 }
 render();
</script>
</body></html>`;
}
