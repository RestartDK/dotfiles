import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const NETNS_DIRECTORY = "/var/run/netns";

function isNotFound(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function currentNamedNetworkNamespace(): Promise<string | undefined> {
	if (process.platform !== "linux") {
		return undefined;
	}

	const current = await stat("/proc/self/ns/net", { bigint: true });

	let names: string[];
	try {
		names = await readdir(NETNS_DIRECTORY);
	} catch (error) {
		if (isNotFound(error)) {
			return undefined;
		}
		throw error;
	}

	for (const name of names) {
		try {
			const candidate = await stat(join(NETNS_DIRECTORY, name), { bigint: true });
			if (candidate.dev === current.dev && candidate.ino === current.ino) {
				return name;
			}
		} catch (error) {
			if (!isNotFound(error)) {
				throw error;
			}
		}
	}

	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const namespace = await currentNamedNetworkNamespace();
		ctx.ui.setStatus("netns", namespace ? `󰖩 [${namespace}]` : undefined);
	});
}
