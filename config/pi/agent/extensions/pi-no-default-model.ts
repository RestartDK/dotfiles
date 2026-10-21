import { SettingsManager } from "@earendil-works/pi-coding-agent";

const ignoreDefaultChange = (): void => undefined;
const settings = SettingsManager.prototype;

settings.setDefaultModelAndProvider = ignoreDefaultChange;
settings.setDefaultModel = ignoreDefaultChange;
settings.setDefaultProvider = ignoreDefaultChange;
settings.setDefaultThinkingLevel = ignoreDefaultChange;

export default function piNoDefaultModel(): void {
  return undefined;
}
