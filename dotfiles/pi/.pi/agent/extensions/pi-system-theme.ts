import { Theme, type ExtensionAPI, type ExtensionContext, type ThemeColor } from "@mariozechner/pi-coding-agent";

type Rgb = { r: number; g: number; b: number };
type TerminalColors = {
	background: string;
	foreground: string;
	palette: string[];
};

type ThemeBg = "selectedBg" | "userMessageBg" | "customMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

const FALLBACK_PALETTE = [
	"#000000",
	"#f7768e",
	"#9ece6a",
	"#e0af68",
	"#7aa2f7",
	"#bb9af7",
	"#7dcfff",
	"#c0caf5",
	"#414868",
	"#f7768e",
	"#9ece6a",
	"#e0af68",
	"#7aa2f7",
	"#bb9af7",
	"#7dcfff",
	"#c0caf5",
];

function hexToRgb(hex: string): Rgb {
	const clean = hex.replace("#", "");
	return {
		r: parseInt(clean.slice(0, 2), 16),
		g: parseInt(clean.slice(2, 4), 16),
		b: parseInt(clean.slice(4, 6), 16),
	};
}

function rgbToHex({ r, g, b }: Rgb): string {
	const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
	return `#${h(r)}${h(g)}${h(b)}`;
}

function parseOscColor(value: string): string | undefined {
	if (value.startsWith("#") && /^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
	if (value.startsWith("rgb:")) {
		const parts = value.slice(4).split("/");
		if (parts.length >= 3) {
			return rgbToHex({
				r: parseInt(parts[0], 16) >> 8,
				g: parseInt(parts[1], 16) >> 8,
				b: parseInt(parts[2], 16) >> 8,
			});
		}
	}
	if (value.startsWith("rgb(")) {
		const parts = value.slice(4, -1).split(",").map((x) => parseInt(x.trim(), 10));
		if (parts.length >= 3 && parts.every((x) => Number.isFinite(x))) {
			return rgbToHex({ r: parts[0], g: parts[1], b: parts[2] });
		}
	}
	return undefined;
}

function tint(base: string, overlay: string, alpha: number): string {
	const a = hexToRgb(base);
	const b = hexToRgb(overlay);
	return rgbToHex({
		r: a.r + (b.r - a.r) * alpha,
		g: a.g + (b.g - a.g) * alpha,
		b: a.b + (b.b - a.b) * alpha,
	});
}

function luminance(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function generateGrayScale(bg: string): Record<number, string> {
	const rgb = hexToRgb(bg);
	const lum = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
	const dark = lum <= 127;
	const result: Record<number, string> = {};

	for (let i = 1; i <= 12; i++) {
		const factor = i / 12;
		let next: Rgb;
		if (dark) {
			const targetLum = lum < 10 ? factor * 0.4 * 255 : lum + (255 - lum) * factor * 0.34;
			const ratio = lum < 10 ? 1 : targetLum / lum;
			next = lum < 10 ? { r: targetLum, g: targetLum, b: targetLum } : { r: rgb.r * ratio, g: rgb.g * ratio, b: rgb.b * ratio };
		} else {
			const targetLum = lum > 245 ? 255 - factor * 0.4 * 255 : lum * (1 - factor * 0.34);
			const ratio = lum > 245 ? 1 : targetLum / lum;
			next = lum > 245 ? { r: targetLum, g: targetLum, b: targetLum } : { r: rgb.r * ratio, g: rgb.g * ratio, b: rgb.b * ratio };
		}
		result[i] = rgbToHex(next);
	}
	return result;
}

function mutedText(bg: string): string {
	const lum = luminance(bg) * 255;
	if (lum <= 127) {
		const value = Math.min(Math.floor(150 + lum * 0.35), 190);
		return rgbToHex({ r: value, g: value, b: value });
	}
	const value = Math.max(Math.floor(105 - (255 - lum) * 0.2), 58);
	return rgbToHex({ r: value, g: value, b: value });
}

async function queryTerminalColors(): Promise<TerminalColors> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return { background: "#1a1b26", foreground: "#c0caf5", palette: FALLBACK_PALETTE };
	}

	return await new Promise((resolve) => {
		let background: string | undefined;
		let foreground: string | undefined;
		const palette = [...FALLBACK_PALETTE];
		const wasRaw = process.stdin.isRaw;

		const cleanup = () => {
			process.stdin.off("data", onData);
			try {
				process.stdin.setRawMode?.(wasRaw);
			} catch {}
		};

		const finish = () => {
			cleanup();
			resolve({
				background: background ?? "#1a1b26",
				foreground: foreground ?? "#c0caf5",
				palette,
			});
		};

		const onData = (chunk: Buffer | string) => {
			const text = chunk.toString();
			for (const match of text.matchAll(/\x1b\]11;([^\x07\x1b]+)(?:\x07|\x1b\\)/g)) {
				background = parseOscColor(match[1]) ?? background;
			}
			for (const match of text.matchAll(/\x1b\]10;([^\x07\x1b]+)(?:\x07|\x1b\\)/g)) {
				foreground = parseOscColor(match[1]) ?? foreground;
			}
			for (const match of text.matchAll(/\x1b\]4;(\d+);([^\x07\x1b]+)(?:\x07|\x1b\\)/g)) {
				const index = parseInt(match[1], 10);
				const color = parseOscColor(match[2]);
				if (color && index >= 0 && index < 16) palette[index] = color;
			}
		};

		try {
			process.stdin.setRawMode?.(true);
		} catch {}
		process.stdin.on("data", onData);
		process.stdout.write("\x1b]11;?\x07\x1b]10;?\x07");
		for (let i = 0; i < 16; i++) process.stdout.write(`\x1b]4;${i};?\x07`);
		setTimeout(finish, 250);
	});
}

function buildTheme(colors: TerminalColors): Theme {
	const bg = colors.background;
	const fg = colors.foreground;
	const p = (i: number) => colors.palette[i] ?? FALLBACK_PALETTE[i] ?? "#ffffff";
	const gray = generateGrayScale(bg);
	const textMuted = mutedText(bg);
	const isDark = luminance(bg) <= 0.5;
	const selectedFg = isDark ? bg : fg;

	const fgColors: Record<ThemeColor, string | number> = {
		accent: p(6),
		border: gray[7],
		borderAccent: p(6),
		borderMuted: gray[5],
		success: p(2),
		error: p(1),
		warning: p(3),
		muted: textMuted,
		dim: gray[6],
		text: "",
		thinkingText: textMuted,
		userMessageText: "",
		customMessageText: "",
		customMessageLabel: p(5),
		toolTitle: p(6),
		toolOutput: textMuted,
		mdHeading: p(5),
		mdLink: p(4),
		mdLinkUrl: textMuted,
		mdCode: p(2),
		mdCodeBlock: "",
		mdCodeBlockBorder: gray[6],
		mdQuote: textMuted,
		mdQuoteBorder: gray[6],
		mdHr: gray[6],
		mdListBullet: p(6),
		toolDiffAdded: p(2),
		toolDiffRemoved: p(1),
		toolDiffContext: textMuted,
		syntaxComment: textMuted,
		syntaxKeyword: p(5),
		syntaxFunction: p(4),
		syntaxVariable: fg,
		syntaxString: p(2),
		syntaxNumber: p(3),
		syntaxType: p(6),
		syntaxOperator: p(6),
		syntaxPunctuation: textMuted,
		thinkingOff: gray[5],
		thinkingMinimal: p(4),
		thinkingLow: p(6),
		thinkingMedium: p(6),
		thinkingHigh: p(5),
		thinkingXhigh: p(1),
		bashMode: p(3),
	};

	const bgColors: Record<ThemeBg, string | number> = {
		selectedBg: gray[3],
		userMessageBg: gray[2],
		customMessageBg: gray[2],
		toolPendingBg: gray[2],
		toolSuccessBg: tint(bg, p(2), 0.18),
		toolErrorBg: tint(bg, p(1), 0.18),
	};

	// Keep selected text readable by making accent-selected UI contrast with the terminal background.
	fgColors.text = "";
	fgColors.accent = p(6);
	void selectedFg;

	return new Theme(fgColors, bgColors, "truecolor", { name: "system" });
}

export default function (pi: ExtensionAPI) {
	let current: Theme | undefined;

	async function apply(ctx: ExtensionContext) {
		const terminal = await queryTerminalColors();
		current = buildTheme(terminal);
		ctx.ui.setTheme(current);
	}

	pi.on("session_start", async (_event, ctx) => {
		await apply(ctx);
	});

	pi.registerCommand("system-theme-refresh", {
		description: "Re-query terminal colors and regenerate the dynamic system theme",
		handler: async (_args, ctx) => {
			await apply(ctx);
			ctx.ui.notify("System theme refreshed", "success");
		},
	});
}
