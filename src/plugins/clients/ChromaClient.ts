import { useSyncExternalStore } from "react";
import type {
  AudioAnalyzerData,
  AudioAnalyzerStore,
} from "../../hooks/useAudioAnalyzer";
import { createChromaStyleEngine } from "./chroma/chromaStyles";
import {
  CHROMA_DEVICE_TYPES,
  DEFAULT_CHROMA_SETTINGS,
  type ChromaDeviceType,
  type ChromaFrames,
  type ChromaSettings,
} from "./chroma/chromaTypes";
import type { ChromaVisualizerField } from "./chroma/chromaVisualizerField";
import type { ChromaStatus } from "../../electron";

const SETTINGS_KEY = "wf_chroma_settings";
export const CHROMA_SETTINGS_EVENT = "chromaSettingsChanged";

const EMPTY_DEVICE_STATUS = {
  available: false,
  enabled: true,
  effectCreated: false,
  failures: 0,
  zones: 0,
};
const EMPTY_STATUS: ChromaStatus = {
  active: false,
  platformSupported:
    typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent),
  synapseFound: false,
  registered: false,
  sdkVersion: null,
  sessionId: null,
  lastHeartbeatAt: null,
  devices: {
    keyboard: { ...EMPTY_DEVICE_STATUS },
    mouse: { ...EMPTY_DEVICE_STATUS },
    mousepad: { ...EMPTY_DEVICE_STATUS },
    headset: { ...EMPTY_DEVICE_STATUS },
    keypad: { ...EMPTY_DEVICE_STATUS },
    chromalink: { ...EMPTY_DEVICE_STATUS },
  },
  hardwareDevices: [],
  deviceDiscoveryError: null,
  lastDeviceScanAt: null,
  appListHealth: null,
  lastError: null,
  logs: [],
};

export interface ChromaClientSnapshot {
  active: boolean;
  settings: ChromaSettings;
  status: ChromaStatus;
  preview: ChromaFrames;
  foregroundField: ChromaVisualizerField | null;
  backgroundField: ChromaVisualizerField | null;
  visualizerField: ChromaVisualizerField | null;
  lastFrameAt: number | null;
}

let globalAnalyzerStore: AudioAnalyzerStore | null = null;
let globalPlaybackActive = false;
let client: ReturnType<typeof createClient> | null = null;

function cloneDefaults(): ChromaSettings {
  return structuredClone(DEFAULT_CHROMA_SETTINGS);
}

function clamp(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(max, Math.max(min, number))
    : fallback;
}

function validColor(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : fallback;
}

function validTheme(value: unknown, fallback: ChromaSettings["foregroundTheme"]) {
  return ["razer", "cyber", "sunset", "ocean", "fire", "aurora", "white", "custom"].includes(String(value))
    ? (value as ChromaSettings["foregroundTheme"])
    : fallback;
}

function validDirection(value: unknown, fallback: ChromaSettings["foregroundDirection"]) {
  return ["ltr", "mirror", "center"].includes(String(value))
    ? (value as ChromaSettings["foregroundDirection"])
    : fallback;
}

export function normalizeChromaSettings(value: unknown): ChromaSettings {
  const defaults = cloneDefaults();
  if (!value || typeof value !== "object") return defaults;
  const input = value as Partial<ChromaSettings>;
  const normalized: ChromaSettings = {
    ...defaults,
    schemaVersion: 3,
    spectrumScaleVersion: 2,
    outputEnabled: input.outputEnabled !== false,
    fps: input.fps === 15 ? 15 : 30,
    previewEnabled: input.previewEnabled !== false,
    brightness: clamp(input.brightness, defaults.brightness, 0.01, 1),
    sensitivity: clamp(input.sensitivity, defaults.sensitivity, 0.5, 3),
    smoothing: clamp(input.smoothing, defaults.smoothing, 0, 1),
    decay: clamp(input.decay, defaults.decay, 1, 10),
    size: clamp(
      input.schemaVersion === 3 ? input.size : 5,
      defaults.size,
      1,
      10,
    ),
    spectrumMirrored: input.spectrumMirrored === true,
    colorRotationSpeed: clamp(input.colorRotationSpeed, defaults.colorRotationSpeed, 0, 2),
    foregroundStaticColor: validColor(input.foregroundStaticColor, validColor(input.keyboard?.customColors?.[0], defaults.foregroundStaticColor)),
    foregroundGradient: [
      validColor(input.foregroundGradient?.[0], validColor(input.keyboard?.customColors?.[0], defaults.foregroundGradient[0])),
      validColor(input.foregroundGradient?.[1], validColor(input.keyboard?.customColors?.[1], defaults.foregroundGradient[1])),
    ],
    foregroundTheme: validTheme(input.foregroundTheme ?? input.keyboard?.theme, defaults.foregroundTheme),
    foregroundDirection: validDirection(input.foregroundDirection ?? input.keyboard?.direction, defaults.foregroundDirection),
    foregroundMirrored: input.schemaVersion === 3 ? input.foregroundMirrored === true : input.spectrumMirrored === true,
    foregroundBeatFlash: input.schemaVersion === 3 ? input.foregroundBeatFlash !== false : input.keyboard?.beatFlash !== false,
    foregroundAnimationSpeed: clamp(input.foregroundAnimationSpeed ?? input.colorRotationSpeed, defaults.foregroundAnimationSpeed, 0, 2),
    backgroundEffect: ["off", "static", "breath", "wave", "spectrum"].includes(
      String(input.backgroundEffect),
    )
      ? (input.backgroundEffect as ChromaSettings["backgroundEffect"])
      : defaults.backgroundEffect,
    reactiveBackground: input.reactiveBackground === true,
    backgroundBrightness: clamp(
      input.backgroundBrightness,
      defaults.backgroundBrightness,
      0.01,
      1,
    ),
    backgroundStaticColor: validColor(input.backgroundStaticColor, validColor(input.keyboard?.background, defaults.backgroundStaticColor)),
    backgroundGradient: [
      validColor(input.backgroundGradient?.[0], defaults.backgroundGradient[0]),
      validColor(input.backgroundGradient?.[1], defaults.backgroundGradient[1]),
    ],
    backgroundTheme: validTheme(input.backgroundTheme, defaults.backgroundTheme),
    backgroundDirection: validDirection(input.backgroundDirection, defaults.backgroundDirection),
    backgroundAnimationSpeed: clamp(input.backgroundAnimationSpeed, defaults.backgroundAnimationSpeed, 0, 2),
    runInBackground: input.runInBackground === true,
    idleMode: ["breathing", "static", "off", "release"].includes(
      String(input.idleMode),
    )
      ? (input.idleMode as ChromaSettings["idleMode"])
      : defaults.idleMode,
  };
  const keyboardCandidate = input.keyboard;
  normalized.keyboard = {
    ...defaults.keyboard,
    ...(keyboardCandidate && typeof keyboardCandidate === "object"
      ? keyboardCandidate
      : {}),
    style:
      keyboardCandidate?.style === "bars"
        ? "spectrum-gradient"
        : keyboardCandidate?.style === "pulse"
          ? "radial-pulse"
          : keyboardCandidate?.style || defaults.keyboard.style,
    enabled: keyboardCandidate?.enabled !== false,
    intensity: clamp(
      keyboardCandidate?.intensity,
      defaults.keyboard.intensity ?? 1,
      0,
      1,
    ),
    customColors:
      Array.isArray(keyboardCandidate?.customColors) &&
      keyboardCandidate.customColors.length >= 2
        ? [
            String(keyboardCandidate.customColors[0]),
            String(keyboardCandidate.customColors[1]),
          ]
        : defaults.keyboard.customColors,
  };
  const peripheralDevices = CHROMA_DEVICE_TYPES.filter(
    (device) => device !== "keyboard",
  ) as Exclude<ChromaDeviceType, "keyboard">[];
  for (const device of peripheralDevices) {
    const candidate = input[device];
    normalized[device] = {
      ...defaults[device],
      ...(candidate && typeof candidate === "object" ? candidate : {}),
      enabled: candidate?.enabled !== false,
      intensity: clamp(
        candidate?.intensity,
        defaults[device].intensity ?? 1,
        0,
        1,
      ),
      customColors:
        Array.isArray(candidate?.customColors) &&
        candidate.customColors.length >= 2
          ? [
              String(candidate.customColors[0]),
              String(candidate.customColors[1]),
            ]
          : defaults[device].customColors,
    };
  }
  return normalized;
}

export function loadChromaSettings(): ChromaSettings {
  try {
    return normalizeChromaSettings(
      JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"),
    );
  } catch {
    return cloneDefaults();
  }
}

export function saveChromaSettings(
  patch: Partial<ChromaSettings>,
): ChromaSettings {
  const current = loadChromaSettings();
  const merged: Record<string, unknown> = { ...current, ...patch };
  for (const group of ["foregroundGradient", "backgroundGradient"] as const) {
    if (patch[group]) merged[group] = [...patch[group]];
  }
  for (const device of CHROMA_DEVICE_TYPES) {
    if (patch[device])
      merged[device] = { ...current[device], ...patch[device] };
  }
  const next = normalizeChromaSettings(merged);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  window.dispatchEvent(
    new CustomEvent(CHROMA_SETTINGS_EVENT, { detail: next }),
  );
  return next;
}

export function resetChromaSettings(): ChromaSettings {
  const next = cloneDefaults();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  window.dispatchEvent(
    new CustomEvent(CHROMA_SETTINGS_EVENT, { detail: next }),
  );
  return next;
}

function emptyFrames(): ChromaFrames {
  return {
    keyboard: null,
    mouse: null,
    mousepad: null,
    headset: null,
    keypad: null,
    chromalink: null,
  };
}

function createClient() {
  const engine = createChromaStyleEngine();
  let snapshot: ChromaClientSnapshot = {
    active: false,
    settings:
      typeof localStorage === "undefined"
        ? cloneDefaults()
        : loadChromaSettings(),
    status: EMPTY_STATUS,
    preview: emptyFrames(),
    foregroundField: null,
    backgroundField: null,
    visualizerField: null,
    lastFrameAt: null,
  };
  const listeners = new Set<() => void>();
  let active = false;
  let frameTimer: number | null = null;
  let analyzerUnsubscribe: (() => void) | null = null;
  let backgroundRelease: (() => void) | null = null;
  let statusUnsubscribe: (() => void) | null = null;
  let latestAudio: AudioAnalyzerData | null = null;
  let releaseSent = false;
  let connecting = false;
  let reactivatePromise: Promise<unknown> | null = null;
  const disabledFramesSent = new Set<ChromaDeviceType>();
  const syncedDeviceEnabled = new Map<ChromaDeviceType, boolean>();

  const set = (patch: Partial<ChromaClientSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };

  const applyBackgroundLease = () => {
    backgroundRelease?.();
    backgroundRelease = null;
    if (active && snapshot.settings.outputEnabled && snapshot.settings.runInBackground && globalAnalyzerStore) {
      backgroundRelease = globalAnalyzerStore.retainBackground();
    }
  };

  const ensureAnalyzerSubscription = () => {
    analyzerUnsubscribe?.();
    analyzerUnsubscribe = null;
    if (!active || !snapshot.settings.outputEnabled || !globalAnalyzerStore) return;
    latestAudio = globalAnalyzerStore.getSnapshot();
    analyzerUnsubscribe = globalAnalyzerStore.subscribe(() => {
      latestAudio = globalAnalyzerStore?.getSnapshot() ?? null;
    });
    applyBackgroundLease();
  };

  const syncDeviceEnabled = () => {
    if (!window.electron?.chroma) return;
    for (const device of CHROMA_DEVICE_TYPES) {
      const enabled = snapshot.settings[device].enabled;
      if (syncedDeviceEnabled.get(device) === enabled) continue;
      syncedDeviceEnabled.set(device, enabled);
      void window.electron.chroma
        .setDeviceEnabled(device, enabled)
        .then((status) => set({ status }));
    }
  };

  const connectTransport = async () => {
    if (!window.electron?.chroma || connecting || !snapshot.settings.outputEnabled) return;
    connecting = true;
    try {
      const status = await window.electron.chroma.activate();
      set({ status });
      syncedDeviceEnabled.clear();
      syncDeviceEnabled();
      if (status.registered) set({ status: await window.electron.chroma.refreshDevices() });
    } finally {
      connecting = false;
    }
  };

  const disconnectTransport = async () => {
    if (!window.electron?.chroma) return;
    set({ status: await window.electron.chroma.deactivate() });
    releaseSent = false;
  };

  const pushResult = () => {
    if (!active || !snapshot.settings.outputEnabled) return;
    const settings = snapshot.settings;
    const hidden =
      typeof document !== "undefined" && document.visibilityState === "hidden";
    const result = engine.render(latestAudio, settings, {
      paused: !globalPlaybackActive,
      hidden,
      now: performance.now(),
      hardwareDevices: snapshot.status.hardwareDevices,
    });
    set({
      preview: result.frames,
      foregroundField: result.foregroundField,
      backgroundField: result.backgroundField,
      visualizerField: result.visualizerField,
      lastFrameAt: Date.now(),
    });
    if (result.action === "release") {
      if (!releaseSent) window.electron?.chroma?.pushFrame({ release: true });
      releaseSent = true;
      return;
    }
    releaseSent = false;
    if (
      window.electron?.chroma &&
      !snapshot.status.registered &&
      !connecting &&
      !reactivatePromise
    ) {
      reactivatePromise = window.electron.chroma
        .activate()
        .then((status) => {
          set({ status });
          if (status.registered)
            return window.electron?.chroma
              ?.refreshDevices()
              .then((next) => next && set({ status: next }));
        })
        .finally(() => {
          reactivatePromise = null;
        });
      return;
    }
    for (const device of CHROMA_DEVICE_TYPES) {
      const frame = result.frames[device];
      if (settings[device].enabled && frame) {
        disabledFramesSent.delete(device);
        window.electron?.chroma?.pushFrame({ device, colors: frame });
      } else if (
        !settings[device].enabled &&
        frame &&
        !disabledFramesSent.has(device)
      ) {
        window.electron?.chroma?.pushFrame({ device, colors: frame });
        disabledFramesSent.add(device);
      }
    }
  };

  const restartFrameLoop = () => {
    if (frameTimer !== null) window.clearInterval(frameTimer);
    frameTimer = null;
    if (!active || !snapshot.settings.outputEnabled) return;
    frameTimer = window.setInterval(pushResult, 1000 / snapshot.settings.fps);
    pushResult();
  };

  const handleSettings = (event: Event) => {
    const previous = snapshot.settings;
    const next = normalizeChromaSettings(
      (event as CustomEvent<ChromaSettings>).detail,
    );
    set({ settings: next });
    if (previous.outputEnabled !== next.outputEnabled) {
      ensureAnalyzerSubscription();
      if (next.outputEnabled) void connectTransport();
      else void disconnectTransport();
    }
    syncDeviceEnabled();
    applyBackgroundLease();
    restartFrameLoop();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    activate: async () => {
      if (active) return;
      active = true;
      set({ active: true, settings: loadChromaSettings() });
      window.addEventListener(CHROMA_SETTINGS_EVENT, handleSettings);
      statusUnsubscribe =
        window.electron?.chroma?.onStatus((status) => set({ status })) ?? null;
      ensureAnalyzerSubscription();
      restartFrameLoop();
      if (!window.electron?.chroma) {
        set({
          status: {
            ...EMPTY_STATUS,
            lastError: "Razer Chroma 仅支持 WaveForge Windows 桌面版",
          },
        });
        return;
      }
      await connectTransport();
    },
    deactivate: async () => {
      active = false;
      window.removeEventListener(CHROMA_SETTINGS_EVENT, handleSettings);
      if (frameTimer !== null) window.clearInterval(frameTimer);
      frameTimer = null;
      analyzerUnsubscribe?.();
      analyzerUnsubscribe = null;
      backgroundRelease?.();
      backgroundRelease = null;
      statusUnsubscribe?.();
      statusUnsubscribe = null;
      latestAudio = null;
      engine.reset();
      releaseSent = false;
      set({
        active: false,
        preview: emptyFrames(),
        foregroundField: null,
        backgroundField: null,
        visualizerField: null,
        lastFrameAt: null,
      });
      if (window.electron?.chroma)
        set({ status: await window.electron.chroma.deactivate() });
    },
    refreshDevices: async () => {
      if (!window.electron?.chroma) return snapshot.status;
      const status = await window.electron.chroma.refreshDevices();
      set({ status });
      return status;
    },
    scanHardware: async () => {
      if (!window.electron?.chroma) return snapshot.status;
      const status = await window.electron.chroma.scanHardware();
      set({ status });
      return status;
    },
    inspectAppList: async () => {
      if (!window.electron?.chroma) return snapshot.status;
      const status = await window.electron.chroma.inspectAppList();
      set({ status });
      return status;
    },
    repairAppList: async () => {
      if (!window.electron?.chroma) return { outcome: "process-failed" as const, error: "Windows desktop only" };
      const result = await window.electron.chroma.repairAppList();
      if (result.status) set({ status: result.status });
      return result;
    },
    updateSettings: (patch: Partial<ChromaSettings>) =>
      saveChromaSettings(patch),
    resetSettings: () => resetChromaSettings(),
    ensureAnalyzerSubscription,
    setPlaybackActive: (playing: boolean) => {
      globalPlaybackActive = playing;
      if (!playing) pushResult();
    },
    isActive: () => active,
  };
}

client = createClient();
export const chromaClient = client;

export function setChromaAudioAnalyzerStore(store: AudioAnalyzerStore | null) {
  globalAnalyzerStore = store;
  client?.ensureAnalyzerSubscription();
}

export function setChromaPlaybackActive(playing: boolean) {
  globalPlaybackActive = playing;
  client?.setPlaybackActive(playing);
}

export function useChromaClient(): ChromaClientSnapshot {
  return useSyncExternalStore(
    chromaClient.subscribe,
    chromaClient.getSnapshot,
    chromaClient.getSnapshot,
  );
}

export function getChromaClient() {
  return chromaClient;
}

export type { ChromaDeviceType, ChromaSettings };
