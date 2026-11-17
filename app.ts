#!/usr/bin/env -S npx tsx
/**
 * Bot Discord cho Quest Auto.
 *
 *   npm run bot
 *
 * Cần DISCORD_BOT_TOKEN trong .env hoặc biến môi trường. Bot chỉ nói chuyện bằng
 * slash command, mỗi người tự /link token của mình; token nằm trong .quest-bot.json
 * (quyền 600, đã gitignore) và không bao giờ hiện lại trong tin nhắn.
 */
import { loadEnv } from './src/core/config';
import { logger } from './src/core/logger';
import { QuestWorker } from './src/worker';
import { registerCommands, setBotToken, getMe } from './src/app/rest';
import { startGateway, stopGateway } from './src/app/gateway';
import { handleInteraction, commandDefs } from './src/app/commands';
import { allAccounts, storePath } from './src/app/store';
import { clearMarker, markTokenRejected, rejectedBefore } from './src/app/health';
import { tokenFingerprint } from './src/core/redact';

loadEnv();

const INTENTS = 1; // GUILDS
const AUTO_EVERY_MS = 30 * 60 * 1000;

const token = (process.env.DISCORD_BOT_TOKEN ?? '').trim();

if (!token) {
	logger.error('Thiếu DISCORD_BOT_TOKEN. Thêm vào .env rồi chạy lại: npm run bot');
	process.exit(1);
}

async function main(): Promise<void> {
	setBotToken(token);

	const rejected = rejectedBefore(token);
	if (rejected) {
		logger.error(
			`Token (dấu vân ${rejected.fingerprint}) đã bị Discord từ chối lúc ${rejected.at}: ${rejected.reason}`,
		);
		logger.info('Tạo token mới ở Developer Portal → Bot → Reset Token rồi cập nhật DISCORD_BOT_TOKEN.');
		process.exit(78);
	}

	let me;
	try {
		me = await getMe();
	} catch (error) {
		const message = (error as Error).message;
		logger.error(message);
		markTokenRejected(token, message);
		logger.info('Kiểm tra token ở Developer Portal → Bot → Reset Token, sau đó cập nhật DISCORD_BOT_TOKEN.');
		process.exit(78);
	}
	clearMarker();
	logger.header('Discord Quest Bot', `@${me.username}`);
	logger.info(`Token dấu vân ${tokenFingerprint(token)} · ${me.id}`);
	logger.info(`Đăng ký slash command (${commandDefs.length} lệnh)...`);
	await registerCommands(commandDefs as unknown[]);
	logger.success('Slash command đã đăng ký.');

	// Nạp lại tài khoản đã liên kết để /status hoạt động ngay sau khi restart.
	const linked = allAccounts();
	for (const [, account] of linked) {
		QuestWorker.registerToken(account.tokenId, account.token, false);
	}
	logger.info(`Đã nạp ${linked.length} tài khoản từ ${storePath()}.`);

	startGateway(token, INTENTS, (interaction) => {
		handleInteraction(interaction).catch((error: Error) => {
			logger.error(`Interaction lỗi: ${error.message}`);
		});
	});

	// Vòng quét tự động cho những ai bật /auto.
	const auto = setInterval(() => {
		for (const [, account] of allAccounts()) {
			if (!account.auto) continue;
			if (QuestWorker.getStatus(account.tokenId) === 'running') continue;
			const result = QuestWorker.startQuests(account.tokenId, undefined, false, 10000);
			if (result.started) logger.info(`Tự động quét cho ${account.username}.`);
		}
	}, AUTO_EVERY_MS);
	auto.unref?.();

	// Kiểm tra nhanh proxy nếu có cấu hình: biết ngay máy chủ này có ra được cổng proxy
	// hay không, thay vì đợi tới lúc ai đó dùng /login.
	void (async () => {
		const { proxySource, testProxy, loadProxies } = await import('./src/core/proxies');
		const source = proxySource();
		if (!source.url && !source.file && !source.inline) return;
		const entries = await loadProxies().catch(() => []);
		if (entries.length === 0) {
			logger.warn('Có cấu hình proxy nhưng danh sách rỗng.');
			return;
		}
		const first = entries[0];
		const result = await testProxy(first);
		if (result.ok) logger.success(`Proxy ${result.country ?? '?'} ${result.ip} · ${result.ms}ms (${first.label})`);
		else logger.warn(`Proxy ${first.label} không dùng được: ${result.error}`);
	})();

	logger.info('Bot đang chạy. Ctrl+C để dừng.');

	const shutdown = (signal: string) => {
		logger.warn(`Nhận ${signal}, đang dừng bot...`);
		clearInterval(auto);
		stopGateway();
		setTimeout(() => process.exit(0), 300);
	};
	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: Error) => {
	logger.error(error.message);
	process.exit(1);
});
