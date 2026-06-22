import { randomUUID } from "node:crypto";

const OSC_PREFIX = "\x1b]5522;";
const STRING_TERMINATOR = "\x1b\\";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const GHOSTTY_IMAGE_PREFIX = "PI_GHOSTTY_IMAGE_V1:";
const QUERY_SUPPORT = "\x1b[?5522$p";
const ENABLE_PASTE_EVENTS = "\x1b[?5522h";
const DISABLE_PASTE_EVENTS = "\x1b[?5522l";
const IMAGE_MIME_PREFERENCE = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
] as const;
const TEXT_MIME_PREFERENCE = [
	"text/plain;charset=utf-8",
	"text/plain",
	"text/uri-list",
] as const;
const MAX_CLIPBOARD_BYTES = 50 * 1024 * 1024;

type NoticeLevel = "info" | "warning" | "error";
type PasteSource = "paste-event" | "shortcut";
type ClipboardLocation = "clipboard" | "primary";

type ClipboardPacket = {
	status: string;
	id?: string;
	mimeEncoded?: string;
	passwordEncoded?: string;
	location: ClipboardLocation;
	payloadEncoded?: string;
};

type ListingState = {
	phase: "listing";
	source: PasteSource;
	id?: string;
	passwordEncoded?: string;
	location: ClipboardLocation;
	mimeTypes: Map<string, string>;
};

type ContentState = {
	phase: "content";
	source: PasteSource;
	id: string;
	mimeType: string;
	chunks: Buffer[];
	byteLength: number;
};

type ProtocolState = { phase: "idle" } | ListingState | ContentState;

export type ProtocolInputResult =
	| { consume: true }
	| { data: string }
	| undefined;

export type ClipboardPasteProtocolCallbacks = {
	write(data: string): void;
	saveImage(data: Uint8Array, mimeType: string): string;
	notify(message: string, level: NoticeLevel): void;
	onSupport?(supported: boolean): void;
};

export type ClipboardPasteProtocolOptions = {
	requestTimeoutMs?: number;
	maxClipboardBytes?: number;
};

function normalizeMimeType(mimeType: string): string {
	return (mimeType.split(";", 1)[0] ?? "").trim().toLowerCase();
}

function decodeBase64(value: string): Buffer | undefined {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
		return undefined;
	}
	const decoded = Buffer.from(value, "base64");
	const normalizedInput = value.replace(/=+$/, "");
	const normalizedOutput = decoded.toString("base64").replace(/=+$/, "");
	return normalizedInput === normalizedOutput ? decoded : undefined;
}

function decodeBase64Text(value: string): string | undefined {
	const decoded = decodeBase64(value);
	if (!decoded) {
		return undefined;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
	} catch (error) {
		if (error instanceof TypeError) {
			return undefined;
		}
		throw error;
	}
}

function parseClipboardPacket(data: string): ClipboardPacket | undefined {
	if (!data.startsWith(OSC_PREFIX)) {
		return undefined;
	}
	let body: string;
	if (data.endsWith(STRING_TERMINATOR)) {
		body = data.slice(OSC_PREFIX.length, -STRING_TERMINATOR.length);
	} else if (data.endsWith("\x07")) {
		body = data.slice(OSC_PREFIX.length, -1);
	} else {
		return undefined;
	}
	const separatorIndex = body.indexOf(";");
	const metadataText =
		separatorIndex === -1 ? body : body.slice(0, separatorIndex);
	const payloadEncoded =
		separatorIndex === -1 ? undefined : body.slice(separatorIndex + 1);
	const metadata = new Map<string, string>();
	for (const record of metadataText.split(":")) {
		const equalsIndex = record.indexOf("=");
		if (equalsIndex <= 0) {
			return undefined;
		}
		metadata.set(record.slice(0, equalsIndex), record.slice(equalsIndex + 1));
	}
	if (metadata.get("type") !== "read") {
		return undefined;
	}
	const status = metadata.get("status");
	if (!status) {
		return undefined;
	}
	const id = metadata.get("id");
	if (id && !/^[A-Za-z0-9_.+-]+$/.test(id)) {
		return undefined;
	}
	const passwordEncoded = metadata.get("pw");
	if (passwordEncoded && !decodeBase64(passwordEncoded)) {
		return undefined;
	}
	return {
		status,
		id,
		mimeEncoded: metadata.get("mime"),
		passwordEncoded,
		location: metadata.get("loc") === "primary" ? "primary" : "clipboard",
		payloadEncoded,
	};
}

function selectMimeType(
	mimeTypes: Map<string, string>,
	preference: readonly string[],
): string | undefined {
	for (const preferred of preference) {
		const selected = mimeTypes.get(preferred);
		if (selected) {
			return selected;
		}
	}
	return undefined;
}

function isExpectedImage(data: Uint8Array, mimeType: string): boolean {
	const bytes = Buffer.from(data);
	switch (normalizeMimeType(mimeType)) {
		case "image/png":
			return (
				bytes.length >= 8 &&
				bytes
					.subarray(0, 8)
					.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
			);
		case "image/jpeg":
			return (
				bytes.length >= 3 &&
				bytes[0] === 0xff &&
				bytes[1] === 0xd8 &&
				bytes[2] === 0xff
			);
		case "image/gif":
			return (
				bytes.length >= 6 &&
				["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
			);
		case "image/webp":
			return (
				bytes.length >= 12 &&
				bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
				bytes.subarray(8, 12).toString("ascii") === "WEBP"
			);
		default:
			return false;
	}
}

function bracketPaste(text: string): string {
	const sanitized = text.replaceAll(PASTE_START, "").replaceAll(PASTE_END, "");
	return `${PASTE_START}${sanitized}${PASTE_END}`;
}

export class ClipboardPasteProtocol {
	private state: ProtocolState = { phase: "idle" };
	private timeout: ReturnType<typeof setTimeout> | undefined;
	private readonly requestTimeoutMs: number;
	private readonly maxClipboardBytes: number;
	private readonly sessionPasswordEncoded = Buffer.from(
		randomUUID(),
		"utf-8",
	).toString("base64");
	private readonly sessionNameEncoded = Buffer.from(
		"Pi SSH image paste",
		"utf-8",
	).toString("base64");

	constructor(
		private readonly callbacks: ClipboardPasteProtocolCallbacks,
		options: ClipboardPasteProtocolOptions = {},
	) {
		this.requestTimeoutMs = options.requestTimeoutMs ?? 15000;
		this.maxClipboardBytes = options.maxClipboardBytes ?? MAX_CLIPBOARD_BYTES;
	}

	start(): void {
		this.callbacks.write(`${QUERY_SUPPORT}${ENABLE_PASTE_EVENTS}`);
	}

	stop(): void {
		this.clearTimeout();
		this.state = { phase: "idle" };
		this.callbacks.write(DISABLE_PASTE_EVENTS);
	}

	requestImage(): void {
		if (this.state.phase !== "idle") {
			this.callbacks.notify(
				"A clipboard request is already in progress",
				"warning",
			);
			return;
		}
		const id = this.newRequestId();
		this.state = {
			phase: "listing",
			source: "shortcut",
			id,
			passwordEncoded: this.sessionPasswordEncoded,
			location: "clipboard",
			mimeTypes: new Map(),
		};
		this.sendReadRequest(
			".",
			id,
			"clipboard",
			this.sessionPasswordEncoded,
			this.sessionNameEncoded,
		);
		this.refreshTimeout();
	}

	handleInput(data: string): ProtocolInputResult {
		const ghosttyImage = this.handleGhosttyImagePaste(data);
		if (ghosttyImage) {
			return ghosttyImage;
		}
		const supportPrefix = "\x1b[?5522;";
		if (data.startsWith(supportPrefix) && data.endsWith("$y")) {
			const statusText = data.slice(supportPrefix.length, -2);
			if (/^[0-4]$/.test(statusText)) {
				const status = Number(statusText);
				this.callbacks.onSupport?.(status !== 0 && status !== 4);
				return { consume: true };
			}
		}
		const packet = parseClipboardPacket(data);
		if (!packet) {
			return undefined;
		}
		return this.handlePacket(packet);
	}

	private handleGhosttyImagePaste(data: string): ProtocolInputResult {
		const prefix = `${PASTE_START}${GHOSTTY_IMAGE_PREFIX}`;
		if (!data.startsWith(prefix) || !data.endsWith(PASTE_END)) {
			return undefined;
		}
		const payload = data.slice(prefix.length, -PASTE_END.length);
		const separatorIndex = payload.indexOf(":");
		if (separatorIndex <= 0) {
			this.callbacks.notify("Ghostty sent an invalid image paste", "error");
			return { consume: true };
		}
		const mimeType = normalizeMimeType(payload.slice(0, separatorIndex));
		const encodedImage = payload.slice(separatorIndex + 1);
		if (encodedImage.length > Math.ceil(this.maxClipboardBytes / 3) * 4) {
			this.callbacks.notify(
				`Clipboard content exceeds ${this.maxClipboardBytes} bytes`,
				"error",
			);
			return { consume: true };
		}
		const image = decodeBase64(encodedImage);
		if (!image || image.length > this.maxClipboardBytes) {
			this.callbacks.notify("Ghostty sent invalid base64 image data", "error");
			return { consume: true };
		}
		if (!isExpectedImage(image, mimeType)) {
			this.callbacks.notify(
				"Clipboard image data does not match its MIME type",
				"error",
			);
			return { consume: true };
		}
		try {
			return {
				data: bracketPaste(this.callbacks.saveImage(image, mimeType)),
			};
		} catch (error) {
			this.callbacks.notify(
				`Could not save clipboard image: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return { consume: true };
		}
	}

	private handlePacket(packet: ClipboardPacket): ProtocolInputResult {
		if (this.state.phase === "idle") {
			if (packet.status !== "OK" || packet.id) {
				return { consume: true };
			}
			this.state = {
				phase: "listing",
				source: "paste-event",
				passwordEncoded: packet.passwordEncoded,
				location: packet.location,
				mimeTypes: new Map(),
			};
			this.refreshTimeout();
			return { consume: true };
		}
		if (!this.packetMatchesState(packet)) {
			return { consume: true };
		}
		if (!["OK", "DATA", "DONE"].includes(packet.status)) {
			this.fail(`Terminal clipboard request failed: ${packet.status}`);
			return { consume: true };
		}
		this.refreshTimeout();
		if (packet.status === "OK") {
			if (this.state.phase === "listing") {
				this.state.passwordEncoded =
					packet.passwordEncoded ?? this.state.passwordEncoded;
				this.state.location = packet.location;
			}
			return { consume: true };
		}
		if (packet.status === "DATA") {
			if (this.state.phase === "listing") {
				this.collectMimeTypes(this.state, packet);
			} else {
				this.collectContent(this.state, packet);
			}
			return { consume: true };
		}
		if (this.state.phase === "listing") {
			return this.finishListing(this.state);
		}
		return this.finishContent(this.state);
	}

	private packetMatchesState(packet: ClipboardPacket): boolean {
		if (this.state.phase === "idle") {
			return false;
		}
		if (this.state.id) {
			return packet.id === this.state.id;
		}
		return packet.id === undefined;
	}

	private collectMimeTypes(state: ListingState, packet: ClipboardPacket): void {
		const mimeType = packet.mimeEncoded
			? decodeBase64Text(packet.mimeEncoded)
			: undefined;
		if (mimeType && mimeType !== ".") {
			state.mimeTypes.set(normalizeMimeType(mimeType), mimeType);
		}
		if (!packet.payloadEncoded) {
			return;
		}
		const payload = decodeBase64Text(packet.payloadEncoded);
		if (payload === undefined) {
			this.fail("Terminal sent an invalid clipboard MIME list");
			return;
		}
		for (const listedMimeType of payload.split(/\s+/).filter(Boolean)) {
			state.mimeTypes.set(normalizeMimeType(listedMimeType), listedMimeType);
		}
	}

	private collectContent(state: ContentState, packet: ClipboardPacket): void {
		if (!packet.payloadEncoded) {
			return;
		}
		const mimeType = packet.mimeEncoded
			? decodeBase64Text(packet.mimeEncoded)
			: undefined;
		if (
			mimeType &&
			normalizeMimeType(mimeType) !== normalizeMimeType(state.mimeType)
		) {
			this.fail(
				"Terminal returned a different clipboard MIME type than requested",
			);
			return;
		}
		const chunk = decodeBase64(packet.payloadEncoded);
		if (!chunk) {
			this.fail("Terminal sent invalid base64 clipboard data");
			return;
		}
		if (state.byteLength + chunk.length > this.maxClipboardBytes) {
			this.fail(`Clipboard content exceeds ${this.maxClipboardBytes} bytes`);
			return;
		}
		state.chunks.push(chunk);
		state.byteLength += chunk.length;
	}

	private finishListing(state: ListingState): ProtocolInputResult {
		const imageMimeType = selectMimeType(
			state.mimeTypes,
			IMAGE_MIME_PREFERENCE,
		);
		const textMimeType = selectMimeType(state.mimeTypes, TEXT_MIME_PREFERENCE);
		const mimeType =
			imageMimeType ??
			(state.source === "paste-event" ? textMimeType : undefined);
		if (!mimeType) {
			this.clearTimeout();
			this.state = { phase: "idle" };
			this.callbacks.notify(
				state.source === "shortcut"
					? "The clipboard does not contain a supported image"
					: "The clipboard has no supported image or text content",
				"warning",
			);
			return { consume: true };
		}
		const id = this.newRequestId();
		const passwordEncoded =
			state.passwordEncoded ??
			(state.source === "shortcut" ? this.sessionPasswordEncoded : undefined);
		const nameEncoded = Buffer.from(
			state.source === "paste-event" ? "Paste event" : "Pi SSH image paste",
			"utf-8",
		).toString("base64");
		this.state = {
			phase: "content",
			source: state.source,
			id,
			mimeType,
			chunks: [],
			byteLength: 0,
		};
		this.sendReadRequest(
			mimeType,
			id,
			state.location,
			passwordEncoded,
			nameEncoded,
		);
		this.refreshTimeout();
		return { consume: true };
	}

	private finishContent(state: ContentState): ProtocolInputResult {
		this.clearTimeout();
		this.state = { phase: "idle" };
		const content = Buffer.concat(state.chunks, state.byteLength);
		if (normalizeMimeType(state.mimeType).startsWith("image/")) {
			if (!isExpectedImage(content, state.mimeType)) {
				this.callbacks.notify(
					"Clipboard image data does not match its MIME type",
					"error",
				);
				return { consume: true };
			}
			try {
				return {
					data: bracketPaste(
						this.callbacks.saveImage(
							content,
							normalizeMimeType(state.mimeType),
						),
					),
				};
			} catch (error) {
				this.callbacks.notify(
					`Could not save clipboard image: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return { consume: true };
			}
		}
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
			return text ? { data: bracketPaste(text) } : { consume: true };
		} catch (error) {
			if (error instanceof TypeError) {
				this.callbacks.notify("Clipboard text is not valid UTF-8", "error");
				return { consume: true };
			}
			throw error;
		}
	}

	private sendReadRequest(
		mimeType: string,
		id: string,
		location: ClipboardLocation,
		passwordEncoded: string | undefined,
		nameEncoded: string,
	): void {
		const mimeEncoded = Buffer.from(mimeType, "utf-8").toString("base64");
		const metadata = ["type=read", `id=${id}`, `mime=${mimeEncoded}`];
		if (location === "primary") {
			metadata.push("loc=primary");
		}
		if (passwordEncoded) {
			metadata.push(`pw=${passwordEncoded}`);
		}
		metadata.push(`name=${nameEncoded}`);
		this.callbacks.write(
			`${OSC_PREFIX}${metadata.join(":")};${mimeEncoded}${STRING_TERMINATOR}`,
		);
	}

	private newRequestId(): string {
		return `pi-${randomUUID()}`;
	}

	private refreshTimeout(): void {
		this.clearTimeout();
		if (this.requestTimeoutMs <= 0) {
			return;
		}
		this.timeout = setTimeout(() => {
			this.state = { phase: "idle" };
			this.timeout = undefined;
			this.callbacks.notify("Terminal clipboard request timed out", "error");
		}, this.requestTimeoutMs);
	}

	private clearTimeout(): void {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = undefined;
		}
	}

	private fail(message: string): void {
		this.clearTimeout();
		this.state = { phase: "idle" };
		this.callbacks.notify(message, "error");
	}
}
