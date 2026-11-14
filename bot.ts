#!/usr/bin/env -S npx tsx
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadEnv, getToken, tokenIdFor, readState, writeState, clearState, isAlive } from './src/core/config';
import { logger } from './src/core/logger';
import type { Command, QuestShape } from './src/core/interface';

loadEnv();

const argv = process.argv.slice(2);
const command = (argv.find((arg) => !arg.startsWith('--')) ?? 'run').toLowerCase() as Command;

function flag(name: string): string | undefined {
	const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : undefined;
}

const has = (name: string) => argv.includes(`--${name}`);

const HELP = `Discord Quest Auto

Cách dùng
  npm start                      chạy trong terminal, hỏi token nếu chưa có
  npx tsx bot.ts [lệnh] [tuỳ chọn]

Chưa có TOKEN trong .env thì bot hỏi ngay trong terminal (gõ bị che), xong hỏi
có lưu vào .env hay không.

Lệnh
  run       làm toàn bộ quest đang có rồi tự nhận thưởng   (mặc định)
  list      liệt kê quest kèm tiến trình
  claim     nhận thưởng cho quest đã hoàn thành
  auto      chạy nền, quét lại mỗi 5 phút
  status    trạng thái tiến trình + tiến trình thật từ Discord
  stop      dừng tiến trình run/auto đang chạy

Tuỳ chọn
  --quest=<id>     chỉ làm một quest
  --multi          chạy song song (mặc định tuần tự)
  --force          bỏ qua kiểm tra server bắt buộc
  --json           (list) in JSON
  --log=<file>     ghi log ra file
  --gap=<giây>     nghỉ tối thiểu giữa hai quest (mặc định 10)
  --no-color       tắt màu (hoặc đặt NO_COLOR=1)
  --token=<token>  dùng token khác trong .env

Môi trường: Linux, macOS, Windows (cmd/PowerShell), Termux. Cần Node 20+.
Gõ: npm start | npm run list | npm run claim | npm run auto`;

/** Bàn phím dùng chung cho các câu hỏi: giữ lại ký tự gõ dư giữa hai lần hỏi. */
const keys: string[] = [];
let keysOn = false;

function keysStart(): void {
	if (keysOn) return;
	keysOn = true;
	const stdin = process.stdin;
	stdin.setRawMode?.(true);
	stdin.resume();
	stdin.setEncoding('utf8');
	stdin.on('data', (chunk: string) => {
		for (const ch of chunk) keys.push(ch);
	});
}

function keysStop(): void {
	if (!keysOn) return;
	keysOn = false;
	process.stdin.setRawMode?.(false);
	process.stdin.pause();
}

async function nextKey(): Promise<string> {
	for (;;) {
		const hit = keys.shift();
		if (hit !== undefined) return hit;
		await new Promise((resolve) => setTimeout(resolve, 8));
	}
}

/** Đọc token: che ký tự khi có TTY, đọc dòng đầu khi bị pipe. */
async function askToken(): Promise<string | null> {
	const stdin = process.stdin;

	if (!stdin.isTTY) {
		// Cho phép `echo $TOKEN | npm start`, nhưng không treo khi stdin câm.
		const piped = (async () => {
			let text = '';
			for await (const chunk of stdin) {
				text += String(chunk);
				if (text.includes('\n')) break;
			}
			return text.split(/\r?\n/)[0]?.trim() || null;
		})();
		const quiet = new Promise<null>((resolve) => setTimeout(() => resolve(null), 400));
		return Promise.race([piped, quiet]);
	}

	process.stdout.write(`${logger.color.cyan}?${logger.color.reset} Dán token Discord: `);
	keysStart();

	let value = '';
	for (;;) {
		const ch = await nextKey();
		if (ch === '\r' || ch === '\n') break;
		if (ch === '\u0003') {
			keysStop();
			process.stdout.write('\n');
			process.exit(130);
		}
		if (ch === '\u007f' || ch === '\b') {
			if (value) {
				value = value.slice(0, -1);
				process.stdout.write('\b \b');
			}
			continue;
		}
		if (ch >= ' ') {
			value += ch;
			process.stdout.write('*');
		}
	}

	keysStop();
	process.stdout.write('\n');
	return value.trim() || null;
}

/** Hỏi có/không bằng một phím. */
async function confirm(question: string, fallback = true): Promise<boolean> {
	if (!process.stdin.isTTY) return false;

	process.stdout.write(`${logger.color.cyan}?${logger.color.reset} ${question} ${fallback ? '(Y/n)' : '(y/N)'} `);
	keysStart();

	for (;;) {
		const ch = (await nextKey()).toLowerCase();
		if (ch === '\u0003') {
			keysStop();
			process.exit(130);
		}
		if (ch === 'y' || ch === 'n') {
			keysStop();
			process.stdout.write(`${ch === 'y' ? 'có' : 'không'}\n`);
			return ch === 'y';
		}
		if (ch === '\r' || ch === '\n') {
			keysStop();
			process.stdout.write(`${fallback ? 'có' : 'không'}\n`);
			return fallback;
		}
	}
}

/** Ghi token vào .env để lần sau khỏi dán. */
function saveToken(token: string): void {
	const file = '.env';
	const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
	const kept = lines.filter((line) => !/^\s*TOKEN\s*=/.test(line));
	while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
	kept.push(`TOKEN=${token}`, '');
	writeFileSync(file, kept.join('\n'));
	logger.success('Đã lưu token vào .env.');
}

/** In log của engine ra terminal cho tới khi hàng đợi rảnh. */
async function tail(tokenId: string, untilIdle: boolean): Promise<void> {
	const { QuestWorker } = await import('./src/worker');
	const startedAt = Date.now();
	let printed = 0;
	let idle = 0;

	for (;;) {
		const logs = QuestWorker.getLogs(tokenId);
		for (; printed < logs.length; printed += 1) {
			const entry = logs[printed];
			const level =
				entry.level === 'success'
					? 'success'
					: entry.level === 'error'
						? 'error'
						: entry.level === 'warn'
							? 'warn'
							: 'info';
			logger[level](entry.message);
		}

		if (untilIdle) {
			const busy =
				QuestWorker.getStatus(tokenId) === 'running' ||
				(QuestWorker.getState(tokenId)?.apiQueue?.length ?? 0) > 0;
			if (busy) idle = 0;
			else if (Date.now() - startedAt > 6_000) {
				idle += 1;
				if (idle >= 4) return;
			}
		}

		await new Promise((resolve) => setTimeout(resolve, 400));
	}
}

/** Kiểm tra tài khoản và server bắt buộc. */
async function prepare(token: string) {
	const { initBuildVersion, getDiscordProfile, discordFetch } = await import('./src/api/client');
	const { REQUIRED_GUILD_ID, GUILD_INVITE_URL } = await import('./src/core/constants');

	await initBuildVersion().catch(() => {});
	const tokenId = tokenIdFor(token);

	let user: Record<string, any>;
	try {
		({ user } = (await getDiscordProfile(token, tokenId)) as { user: Record<string, any> });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/Failed to fetch profile|401|Invalid token/i.test(message)) {
			throw new Error('Token không hợp lệ hoặc đã hết hạn. Lấy token mới rồi sửa TOKEN trong .env.');
		}
		throw error;
	}

	let isVerified = false;
	try {
		const res = await discordFetch(token, '/users/@me/guilds', {}, tokenId);
		if (res.ok) {
			const guilds = (await res.json()) as Array<{ id: string }>;
			isVerified = Array.isArray(guilds) && guilds.some((guild) => String(guild.id) === REQUIRED_GUILD_ID);
		}
	} catch {
		/* không kiểm tra được thì coi như chưa xác minh */
	}

	return { token, tokenId, user, isVerified, invite: GUILD_INVITE_URL };
}

/** Nhận thưởng cho mọi quest đã xong nhưng chưa nhận. */
async function claimCompleted(token: string, tokenId: string): Promise<number> {
	const { fetchDiscordQuests, claimQuestReward } = await import('./src/api/client');
	const { quests } = await fetchDiscordQuests(token, tokenId);

	let claimed = 0;
	for (const quest of quests as Array<Record<string, any>>) {
		const status = quest.user_status as Record<string, any> | undefined;
		if (!status?.completed_at || status?.claimed_at) continue;

		const name = (quest.config?.messages?.quest_name as string) ?? String(quest.id).slice(0, 8);
		const res = await claimQuestReward(token, String(quest.id), quest, tokenId).catch(() => null);
		if (res?.ok) {
			claimed += 1;
			logger.success(`Đã nhận thưởng: ${name}`);
		} else {
			logger.warn(`Chưa nhận được thưởng: ${name}`);
		}
	}
	return claimed;
}

async function main(): Promise<void> {
	const known = ['run', 'list', 'claim', 'auto', 'status', 'stop', 'help'];
	if (!known.includes(command)) {
		logger.error(`Không có lệnh "${command}".`);
		logger.blank();
		logger.plain(HELP);
		process.exit(1);
	}

	if (command === 'help' || has('help')) {
		logger.plain(HELP);
		return;
	}

	if (command === 'stop') {
		const state = readState();
		if (!state) return logger.info('Không có tiến trình nào đang chạy.');
		if (!isAlive(state.pid)) {
			clearState();
			return logger.warn(`pid ${state.pid} đã dừng trước đó.`);
		}
		process.kill(state.pid, 'SIGTERM');
		clearState();
		logger.success(`Đã dừng pid ${state.pid}.`);
		return;
	}

	let token: string;
	try {
		token = getToken(flag('token'));
	} catch (error) {
		const typed = await askToken();
		if (!typed) throw error;
		token = typed;
		if (await confirm('Lưu token vào .env cho lần sau?')) saveToken(token);
	}

	if (command === 'status') {
		const state = readState();
		logger.header('Trạng thái');
		logger.info(
			state && isAlive(state.pid) ? `Đang chạy · pid ${state.pid} · ${state.mode}` : 'Không có tiến trình nền.',
		);

		const { fetchDiscordQuests } = await import('./src/api/client');
		const { Quest } = await import('./src/quests/quest');
		const tokenId = tokenIdFor(token);
		let quests: QuestShape[];
		try {
			({ quests } = await fetchDiscordQuests(token, tokenId));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/401|Unauthorized/i.test(message)) {
				throw new Error('Token không hợp lệ hoặc đã hết hạn. Sửa TOKEN trong .env.');
			}
			throw error;
		}
		const list = quests.map((q) => Quest.create(q));
		logger.info(
			`${list.length} quest · cần làm ${list.filter((q) => !q.isClaimed()).length} · chờ nhận ${list.filter((q) => q.isCompleted() && !q.isClaimed()).length}`,
		);
		return;
	}

	const session = await prepare(token);
	const { QuestWorker } = await import('./src/worker');
	QuestWorker.registerToken(session.tokenId, session.token, session.isVerified, session.isVerified);

	if (command === 'list') {
		const { fetchDiscordQuests } = await import('./src/api/client');
		const { Quest } = await import('./src/quests/quest');

		logger.header(`Quest của @${session.user.username}`, session.isVerified ? '' : 'chưa ở server bắt buộc');
		const { quests } = await fetchDiscordQuests(session.token, session.tokenId);
		const rows = (quests as QuestShape[]).map((q) => Quest.create(q));
		const visible = has('all') ? rows : rows.filter((q) => !q.isClaimed());

		if (has('json')) {
			logger.plain(
				JSON.stringify(
					visible.map((q) => ({
						id: q.id,
						type: q.type,
						name: q.name,
						progress: q.progress,
						state: q.label(),
					})),
					null,
					2,
				),
			);
			return;
		}

		for (const quest of visible) {
			const bar = '█'.repeat(Math.round(quest.progress / 10)).padEnd(10, '░');
			logger.plain(
				`  ${bar} ${String(Math.round(quest.progress)).padStart(3)}%  ${quest.label().padEnd(9)} ${quest.type.padEnd(22)} ${quest.name.slice(0, 42)}`,
			);
		}
		if (visible.length === 0) logger.info('Không có quest nào cần làm.');
		return;
	}

	if (command === 'claim') {
		const claimed = await claimCompleted(session.token, session.tokenId);
		logger.info(claimed === 0 ? 'Không có quest nào chờ nhận thưởng.' : `Đã nhận ${claimed} phần thưởng.`);
		return;
	}

	if (command === 'auto') {
		if (!session.isVerified && !has('force')) {
			throw new Error(`Tài khoản chưa ở server bắt buộc: ${session.invite} (hoặc thêm --force).`);
		}
		const logFile = flag('log') ?? `logs/quest-${new Date().toISOString().slice(0, 10)}.log`;
		const { setLogFile } = await import('./src/core/logger');
		setLogFile(logFile);

		const result = QuestWorker.setAutoQuest(session.tokenId, session.token, true, true);
		if (!result.success) throw new Error(result.message);

		logger.header(`Quest auto · @${session.user.username}`, 'quét lại mỗi 5 phút');
		logger.info(`Log: ${logFile}   ·   Ctrl-C để dừng`);
		writeState({ pid: process.pid, mode: 'auto', tokenId: session.tokenId, startedAt: Date.now(), logFile });

		const shutdown = () => {
			QuestWorker.setAutoQuest(session.tokenId, session.token, false, true);
			QuestWorker.stopQuests(session.tokenId);
			clearState();
			logger.warn('Đã tắt auto-loop.');
			setTimeout(() => process.exit(0), 200);
		};
		process.on('SIGINT', shutdown);
		process.on('SIGTERM', shutdown);

		await tail(session.tokenId, false);
		return;
	}

	// run
	const logFile = flag('log') ?? `logs/quest-${new Date().toISOString().slice(0, 10)}.log`;
	const { setLogFile } = await import('./src/core/logger');
	setLogFile(logFile);

	logger.header(`Quest run · @${session.user.username}`, has('multi') ? 'song song' : 'tuần tự');
	if (!session.isVerified) logger.warn(`Chưa ở server bắt buộc: ${session.invite}`);

	const gapFlag = flag('gap');
	const gapMs = gapFlag ? Math.max(1, Number(gapFlag)) * 1000 : undefined;
	const started = QuestWorker.startQuests(session.tokenId, flag('quest'), has('multi'), gapMs);
	if (!started.started) throw new Error(started.message);

	writeState({ pid: process.pid, mode: 'run', tokenId: session.tokenId, startedAt: Date.now(), logFile });

	const onSignal = () => {
		QuestWorker.stopQuests(session.tokenId);
		clearState();
		process.exit(130);
	};
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);

	try {
		await tail(session.tokenId, true);
		if (QuestWorker.getStatus(session.tokenId) === 'error') {
			throw new Error('Quest dừng vì lỗi, xem log phía trên.');
		}
		if (session.isVerified) {
			logger.info('Quest đã xong. Muốn nhận thưởng thì chạy: bot.ts claim');
		}
		logger.blank();
		logger.success('Xong.');
	} finally {
		process.off('SIGINT', onSignal);
		process.off('SIGTERM', onSignal);
		clearState();
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		logger.blank();
		logger.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
