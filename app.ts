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
	const me = await getMe();
	logger.header('Discord Quest Bot', `@${me.username}`);
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
