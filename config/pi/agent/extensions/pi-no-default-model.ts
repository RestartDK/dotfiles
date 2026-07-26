import { SettingsManager } from "@earendil-works/pi-coding-agent";

// Keep model and thinking-level changes local to the active session. Defaults
// remain managed explicitly in settings.json instead of following UI switches.
const ignoreDefaultChange = (): void => undefined;
const settings = SettingsManager.prototype;

settings.setDefaultModelAndProvider = ignoreDefaultChange;
settings.setDefaultModel = ignoreDefaultChange;
settings.setDefaultProvider = ignoreDefaultChange;
settings.setDefaultThinkingLevel = ignoreDefaultChange;

export default function piNoDefaultModel(): void {
  return undefined;
}
