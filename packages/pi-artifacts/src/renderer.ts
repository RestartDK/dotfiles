import { readFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import type { SatoriDocument } from "./model.js";

export async function renderDocument(document: SatoriDocument): Promise<Buffer> {
  const svg = await satori(document.tree, {
    width: document.width,
    height: document.height,
    fonts: [
      {
        name: "Artifact Sans",
        data: readFileSync(new URL("../fonts/DejaVuSans.ttf", import.meta.url)),
        weight: 400,
        style: "normal",
      },
      {
        name: "Artifact Sans",
        data: readFileSync(new URL("../fonts/DejaVuSans-Bold.ttf", import.meta.url)),
        weight: 700,
        style: "normal",
      },
    ],
  });
  return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng());
}
