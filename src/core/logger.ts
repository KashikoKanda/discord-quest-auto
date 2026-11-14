import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const COLOR = {
	reset: '\u001b[0m',
	dim: '\u001b[2m',
	bold: '\u001b[1m',
	red: '\u001b[31m',
	green: '\u001b[32m',
	yellow: '\u001b[33m',
	cyan: '\u001b[36m',
	magenta: '\u001b[35m',
};

export type Level = 'info' | 'warn' | 'error' | 'success' | 'step';

let logFile: string | null = null;

export function setLogFile(file: string | null): void {
	if (!file) {
		logFile = null;
		return;
	}
	logFile = resolve(file);
	mkdirSync(dirname(logFile), { recursive: true });
}

const ICON: Record<Level, string> = {
	info: '•',
	warn: '▲',
	error: '✖',
	success: '✔',
	step: '→',
};

const PAINT: Record<Level, (text: string) => string> = {
	info: (t) => `${COLOR.cyan}${t}${COLOR.reset}`,
	warn: (t) => `${COLOR.yellow}${t}${COLOR.reset}`,
	error: (t) => `${COLOR.red}${t}${COLOR.reset}`,
	success: (t) => `${COLOR.green}${t}${COLOR.reset}`,
	step: (t) => `${COLOR.magenta}${t}${COLOR.reset}`,
};

const paint = {
	dim: (text: string) => `${COLOR.dim}${text}${COLOR.reset}`,
	bold: (text: string) => `${COLOR.bold}${text}${COLOR.reset}`,
};

export function log(level: Level, message: string): void {
	const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
	process.stdout.write(`${paint.dim(time)} ${PAINT[level](ICON[level])} ${message}\n`);

	if (logFile) {
		try {
			appendFileSync(logFile, `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}\n`);
		} catch {
			/* không chặn chương trình vì log */
		}
	}
}

export const logger = {
	info: (m: string) => log('info', m),
	warn: (m: string) => log('warn', m),
	error: (m: string) => log('error', m),
	success: (m: string) => log('success', m),
	step: (m: string) => log('step', m),
	plain: (m: string) => process.stdout.write(`${m}\n`),
	header: (title: string, sub?: string) => {
		const line = '─'.repeat(56);
		process.stdout.write(
			`\n${paint.dim(line)}\n${paint.bold(title)}${sub ? `  ${paint.dim(sub)}` : ''}\n${paint.dim(line)}\n`,
		);
	},
	blank: () => process.stdout.write('\n'),
	color: COLOR,
};
