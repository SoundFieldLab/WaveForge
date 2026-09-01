import { useSyncExternalStore } from "react";
import type { SignalRgbStatus } from "../../electron";
import type {
  AudioAnalyzerData,
  AudioAnalyzerStore,
} from "../../hooks/useAudioAnalyzer";
import {
  DEFAULT_SIGNALRGB_SETTINGS,
  SIGNALRGB_STYLES,
  type SignalRgbAudioEvent,
  type SignalRgbEventDecisionState,
  type SignalRgbSettings,
  type SignalRgbStyle,
} from "./signalrgb/signalRgbTypes";

export const SIGNALRGB_SETTINGS_KEY = "wf_signalrgb_settings";
export const SIGNALRGB_SETTINGS_EVENT = "signalRgbSettingsChanged";

const EMPTY_STATUS: SignalRgbStatus = {
  platformSupported:
    typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent),
  installed: false,
  running: false,
  localApiAvailable: false,
  proAvailable: null,
  canvasEventAvailable: false,
  effectInstalled: false,
  effectPath: null,
  effectVersion: null,
  hash: null,
  effectHash: null,
  conflict: false,
  restartRequired: false,
  currentEffect: null,
  layout: null,
  layouts: [],
  lastEvent: null,
  errors: [],
  logs: [],
};

export interface SignalRgbClientSnapshot {
  active: boolean;
  busy: boolean;
  settings: SignalRgbSettings;
  status: SignalRgbStatus;
  clientError: string | null;
}

let globalAnalyzerStore: AudioAnalyzerStore | null = null;
let globalPlaybackActive = false;

function clamp(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(max, Math.max(min, number))
    : fallback;
}

function validColor(value: unknown, fallback: string): string {
  const text = String(value ?? "");
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : fallback;
}

export function normalizeSignalRgbSettings(value: unknown): SignalRgbSettings {
  const defaults = DEFAULT_SIGNALRGB_SETTINGS;
  if (!value || typeof value !== "object") {
    return { ...defaults, themeColors: [...defaults.themeColors] };
  }
  const input = value as Partial<SignalRgbSettings> & { enabled?: unknown };
  const colors = Array.isArray(input.themeColors) ? input.themeColors : [];
  const style = SIGNALRGB_STYLES.includes(input.style as SignalRgbStyle)
    ? (input.style as SignalRgbStyle)
    : defaults.style;
  return {
    outputEnabled:
      typeof input.outputEnabled === "boolean"
        ? input.outputEnabled
        : typeof input.enabled === "boolean"
          ? input.enabled
          : defaults.outputEnabled,
    autoApply: input.autoApply === true,
    restoreOnStop: input.restoreOnStop !== false,
    runInBackground: input.runInBackground === true,
    eventEnhancement: input.eventEnhancement !== false,
    getFallback: input.getFallback === true,
    style,
    themeColors: [
      validColor(colors[0], defaults.themeColors[0]),
      validColor(colors[1], defaults.themeColors[1]),
      validColor(colors[2], defaults.themeColors[2]),
    ],
    beatThreshold: clamp(input.beatThreshold, defaults.beatThreshold, 0.1, 1),
    eventCooldown: Math.round(
      clamp(input.eventCooldown, defaults.eventCooldown, 80, 3000),
    ),
  };
}

export function loadSignalRgbSettings(): SignalRgbSettings {
  if (typeof localStorage === "undefined") return normalizeSignalRgbSettings(null);
  try {
    return normalizeSignalRgbSettings(
      JSON.parse(localStorage.getItem(SIGNALRGB_SETTINGS_KEY) || "null"),
    );
  } catch {
    return normalizeSignalRgbSettings(null);
  }
}

export function saveSignalRgbSettings(
  patch: Partial<SignalRgbSettings>,
): SignalRgbSettings {
  const next = normalizeSignalRgbSettings({ ...loadSignalRgbSettings(), ...patch });
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(SIGNALRGB_SETTINGS_KEY, JSON.stringify(next));
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SIGNALRGB_SETTINGS_EVENT, { detail: next }));
  }
  return next;
}

export function selectSignalRgbAudioEvents(
  audio: Pick<AudioAnalyzerData, "beat" | "accent">,
  settings: Pick<SignalRgbSettings, "beatThreshold" | "eventCooldown">,
  state: SignalRgbEventDecisionState,
  now: number,
): SignalRgbAudioEvent[] {
  const events: SignalRgbAudioEvent[] = [];
  const releaseThreshold = settings.beatThreshold * 0.55;
  if (audio.beat < releaseThreshold) state.beatLatched = false;
  if (audio.accent < releaseThreshold) state.accentLatched = false;
  if (
    audio.beat >= settings.beatThreshold &&
    !state.beatLatched &&
    now - state.lastBeatAt >= settings.eventCooldown
  ) {
    state.beatLatched = true;
    state.lastBeatAt = now;
    events.push({
      kind: "beat",
      value: `beat:${Math.max(1, Math.min(100, Math.round(audio.beat * 100)))}`,
    });
  }
  if (
    audio.accent >= settings.beatThreshold &&
    !state.accentLatched &&
    now - state.lastAccentAt >= settings.eventCooldown
  ) {
    state.accentLatched = true;
    state.lastAccentAt = now;
    events.push({
      kind: "accent",
      value: `accent:${Math.max(1, Math.min(100, Math.round(audio.accent * 100)))}`,
    });
  }
  return events;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createClient() {
  let active = false;
  let snapshot: SignalRgbClientSnapshot = {
    active: false,
    busy: false,
    settings: loadSignalRgbSettings(),
    status: EMPTY_STATUS,
    clientError: null,
  };
  const listeners = new Set<() => void>();
  let statusUnsubscribe: (() => void) | null = null;
  let analyzerUnsubscribe: (() => void) | null = null;
  let backgroundRelease: (() => void) | null = null;
  let themeTimer: ReturnType<typeof setTimeout> | null = null;
  let latestAudio: AudioAnalyzerData | null = null;
  let operation: Promise<unknown> | null = null;
  const eventState: SignalRgbEventDecisionState = {
    beatLatched: false,
    accentLatched: false,
    lastBeatAt: -Infinity,
    lastAccentAt: -Infinity,
  };

  const set = (patch: Partial<SignalRgbClientSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };

  const bridge = () =>
    typeof window !== "undefined" ? window.electron?.signalrgb : undefined;

  const sendEvent = async (value: string, force = false) => {
    if (!active || (!force && !snapshot.settings.outputEnabled) || !bridge()) return false;
    try {
      await bridge()!.sendEvent(value, { getFallback: snapshot.settings.getFallback });
      return true;
    } catch (error) {
      set({ clientError: errorMessage(error) });
      return false;
    }
  };

  const processAudio = () => {
    if (!active || !snapshot.settings.outputEnabled || !snapshot.settings.eventEnhancement) return;
    latestAudio = globalAnalyzerStore?.getSnapshot() ?? null;
    if (!latestAudio) return;
    const events = selectSignalRgbAudioEvents(
      latestAudio,
      snapshot.settings,
      eventState,
      Date.now(),
    );
    for (const event of events) void sendEvent(event.value);
  };

  const applyBackgroundLease = () => {
    backgroundRelease?.();
    backgroundRelease = null;
    if (active && snapshot.settings.outputEnabled && snapshot.settings.eventEnhancement && snapshot.settings.runInBackground && globalAnalyzerStore) {
      backgroundRelease = globalAnalyzerStore.retainBackground();
    }
  };

  const ensureAnalyzerSubscription = () => {
    analyzerUnsubscribe?.();
    analyzerUnsubscribe = null;
    latestAudio = globalAnalyzerStore?.getSnapshot() ?? null;
    if (active && snapshot.settings.outputEnabled && snapshot.settings.eventEnhancement && globalAnalyzerStore) {
      analyzerUnsubscribe = globalAnalyzerStore.subscribe(processAudio);
    }
    applyBackgroundLease();
  };

  const handleSettings = (event: Event) => {
    const previous = snapshot.settings;
    const settings = normalizeSignalRgbSettings(
      (event as CustomEvent<SignalRgbSettings>).detail,
    );
    set({ settings });
    ensureAnalyzerSubscription();
    if (!active) return;
    if (previous.outputEnabled && !settings.outputEnabled) {
      void sendEvent("stop", true);
      return;
    }
    if (!settings.outputEnabled) return;
    if (!previous.outputEnabled) {
      void sendEvent(globalPlaybackActive ? "play" : "pause");
      void sendEvent(`style:${settings.style}`);
      void sendEvent(
        `theme:${settings.themeColors[0].slice(1)}:${settings.themeColors[1].slice(1)}`,
      );
      return;
    }
    if (settings.style !== previous.style) void sendEvent(`style:${settings.style}`);
    if (settings.themeColors.join() !== previous.themeColors.join()) {
      if (themeTimer !== null) clearTimeout(themeTimer);
      themeTimer = setTimeout(() => {
        themeTimer = null;
        void sendEvent(
          `theme:${snapshot.settings.themeColors[0].slice(1)}:${snapshot.settings.themeColors[1].slice(1)}`,
        );
      }, 180);
    }
  };

  const runStatusOperation = async (
    action: () => Promise<SignalRgbStatus>,
  ): Promise<SignalRgbStatus> => {
    if (operation) return operation as Promise<SignalRgbStatus>;
    set({ busy: true, clientError: null });
    const task = action()
      .then((status) => {
        set({ status });
        return status;
      })
      .catch((error) => {
        set({ clientError: errorMessage(error) });
        return snapshot.status;
      })
      .finally(() => {
        operation = null;
        set({ busy: false });
      });
    operation = task;
    return task;
  };

  return {
    getSnapshot: () => snapshot,
    getAudioSnapshot: () => latestAudio ?? globalAnalyzerStore?.getSnapshot() ?? null,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    activate: async () => {
      if (active) return snapshot.status;
      active = true;
      set({ active: true, settings: loadSignalRgbSettings(), clientError: null });
      if (typeof window !== "undefined") {
        window.addEventListener(SIGNALRGB_SETTINGS_EVENT, handleSettings);
      }
      statusUnsubscribe = bridge()?.onStatus((status) => set({ status })) ?? null;
      ensureAnalyzerSubscription();
      const api = bridge();
      if (!api) {
        set({ clientError: "SignalRGB 仅支持 WaveForge Windows 桌面版" });
        return snapshot.status;
      }
      await runStatusOperation(() => api.refresh());
      return snapshot.status;
    },
    deactivate: async () => {
      if (!active) return snapshot.status;
      const api = bridge();
      if (snapshot.settings.outputEnabled) await sendEvent("stop");
      active = false;
      if (typeof window !== "undefined") {
        window.removeEventListener(SIGNALRGB_SETTINGS_EVENT, handleSettings);
      }
      statusUnsubscribe?.();
      statusUnsubscribe = null;
      analyzerUnsubscribe?.();
      analyzerUnsubscribe = null;
      backgroundRelease?.();
      backgroundRelease = null;
      if (themeTimer !== null) clearTimeout(themeTimer);
      themeTimer = null;
      latestAudio = null;
      set({ active: false });
      if (api && snapshot.settings.restoreOnStop && snapshot.status.proAvailable === true) {
        await runStatusOperation(() => api.restoreEffect());
      }
      return snapshot.status;
    },
    refresh: () => {
      const api = bridge();
      return api ? runStatusOperation(() => api.refresh()) : Promise.resolve(snapshot.status);
    },
    installEffect: () => {
      const api = bridge();
      return api ? runStatusOperation(() => api.installEffect()) : Promise.resolve(snapshot.status);
    },
    uninstallEffect: () => {
      const api = bridge();
      return api ? runStatusOperation(() => api.uninstallEffect()) : Promise.resolve(snapshot.status);
    },
    applyEffect: () => {
      const api = bridge();
      return api ? runStatusOperation(() => api.applyEffect()) : Promise.resolve(snapshot.status);
    },
    restoreEffect: () => {
      const api = bridge();
      return api ? runStatusOperation(() => api.restoreEffect()) : Promise.resolve(snapshot.status);
    },
    openSignalRgb: async () => {
      try {
        const result = await bridge()?.open();
        if (result && !result.opened) {
          set({ clientError: result.error || "无法打开 SignalRGB" });
        }
        return result ?? { opened: false, path: null, error: "桌面桥不可用" };
      } catch (error) {
        const message = errorMessage(error);
        set({ clientError: message });
        return { opened: false, path: null, error: message };
      }
    },
    updateSettings: (patch: Partial<SignalRgbSettings>) => saveSignalRgbSettings(patch),
    resetSettings: () => saveSignalRgbSettings(DEFAULT_SIGNALRGB_SETTINGS),
    ensureAnalyzerSubscription,
    setPlaybackActive: (playing: boolean) => {
      const changed = globalPlaybackActive !== playing;
      globalPlaybackActive = playing;
      if (!active || !changed) return;
      if (
        playing &&
        snapshot.settings.outputEnabled &&
        snapshot.settings.autoApply &&
        snapshot.status.proAvailable === true &&
        snapshot.status.effectInstalled
      ) {
        const api = bridge();
        if (api) void runStatusOperation(() => api.applyEffect());
      }
      void sendEvent(playing ? "play" : "pause");
    },
    setTheme: (colors: readonly string[]) => {
      const current = snapshot.settings.themeColors;
      const themeColors: [string, string, string] = [
        validColor(colors[0], current[0]),
        validColor(colors[1], current[1]),
        validColor(colors[2], current[2]),
      ];
      return saveSignalRgbSettings({ themeColors });
    },
    isActive: () => active,
  };
}

export const signalRgbClient = createClient();

export function setSignalRgbAudioAnalyzerStore(store: AudioAnalyzerStore | null) {
  globalAnalyzerStore = store;
  signalRgbClient.ensureAnalyzerSubscription();
}

export function setSignalRgbPlaybackActive(playing: boolean) {
  signalRgbClient.setPlaybackActive(playing);
}

export function setSignalRgbTheme(colors: readonly string[]) {
  return signalRgbClient.setTheme(colors);
}

export function useSignalRgbClient(): SignalRgbClientSnapshot {
  return useSyncExternalStore(
    signalRgbClient.subscribe,
    signalRgbClient.getSnapshot,
    signalRgbClient.getSnapshot,
  );
}

export function getSignalRgbClient() {
  return signalRgbClient;
}

export type { SignalRgbSettings, SignalRgbStyle };
