import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tokenIdFor } from '../core/config';

export interface LinkedAccount {
	token: string;
	tokenId: string;
	username: string;
	userId: string;
	linkedAt: number;
	auto: boolean;
}

interface StoreFile {
	users: Record<string, LinkedAccount>;
}

const PATH = process.env.QUEST_BOT_STORE ?? '.quest-bot.json';

function blank(): StoreFile {
	return { users: {} };
}

export function readStore(): StoreFile {
	if (!existsSync(PATH)) return blank();
	try {
		const parsed = JSON.parse(readFileSync(PATH, 'utf8')) as StoreFile;
		if (!parsed || typeof parsed !== 'object' || !parsed.users) return blank();
		return parsed;
	} catch {
		return blank();
	}
}

function write(store: StoreFile): void {
	// Ghi ra tệp tạm rồi đổi tên: nhiều người link cùng lúc hoặc process chết giữa
	// chừng cũng không để lại tệp cụt.
	const tmp = `${PATH}.tmp`;
	writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
	renameSync(tmp, PATH);
	try {
		chmodSync(PATH, 0o600);
	} catch {
		/* Windows: bỏ qua */
	}
}

export function linkAccount(
	discordUserId: string,
	token: string,
	username: string,
	profileUserId: string,
): LinkedAccount {
	const store = readStore();
	const account: LinkedAccount = {
		token,
		tokenId: tokenIdFor(token),
		username,
		userId: profileUserId,
		linkedAt: Date.now(),
		auto: false,
	};
	store.users[discordUserId] = account;
	write(store);
	return account;
}

export function getAccount(discordUserId: string): LinkedAccount | undefined {
	return readStore().users[discordUserId];
}

export function unlinkAccount(discordUserId: string): LinkedAccount | undefined {
	const store = readStore();
	const account = store.users[discordUserId];
	if (!account) return undefined;
	delete store.users[discordUserId];
	write(store);
	return account;
}

export function setAuto(discordUserId: string, auto: boolean): LinkedAccount | undefined {
	const store = readStore();
	const account = store.users[discordUserId];
	if (!account) return undefined;
	account.auto = auto;
	write(store);
	return account;
}

export function allAccounts(): Array<[string, LinkedAccount]> {
	return Object.entries(readStore().users);
}

export function storePath(): string {
	return PATH;
}
