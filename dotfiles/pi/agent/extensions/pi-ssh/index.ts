import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { ClipboardPasteProtocol } from "./protocol.ts";

const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
};

export default function piSshExtension(pi: ExtensionAPI): void {
	let protocol: ClipboardPasteProtocol | undefined;
	let unsubscribe: (() => void) | undefined;

	const requestImage = (
		notify: (message: string, type?: "info" | "warning" | "error") => void,
	): void => {
		if (!protocol) {
			notify(
				"SSH image paste is only available in Pi's interactive terminal mode",
				"warning",
			);
			return;
		}
		protocol.requestImage();
	};

	pi.registerCommand("pi-ssh", {
		description: "Paste an image into Pi through SSH",
		handler: async (_args, ctx) => {
			requestImage((message, type) => ctx.ui.notify(message, type));
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") {
			return;
		}
		ctx.ui.setTitle(`Pi · ${ctx.cwd}`);
		protocol = new ClipboardPasteProtocol({
			write: (data) => process.stdout.write(data),
			saveImage: (data, mimeType) => {
				const extension = IMAGE_EXTENSIONS[mimeType];
				if (!extension) {
					throw new Error(`Unsupported image MIME type: ${mimeType}`);
				}
				const filePath = join(
					tmpdir(),
					`pi-ssh-clipboard-${randomUUID()}.${extension}`,
				);
				writeFileSync(filePath, data, { flag: "wx", mode: 0o600 });
				return filePath;
			},
			notify: (message, level) => ctx.ui.notify(message, level),
		});
		unsubscribe = ctx.ui.onTerminalInput((data) => {
			const result = protocol?.handleInput(data);
			if (result) {
				return result;
			}
			if (matchesKey(data, "ctrl+v") && !isKeyRelease(data)) {
				protocol?.requestImage();
				return { consume: true };
			}
			return undefined;
		});
		protocol.start();
	});

	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
		protocol?.stop();
		protocol = undefined;
	});
}
