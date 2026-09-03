import { beforeEach, describe, expect, it } from "vitest";
import {
  normalizeSignalRgbSettings,
  saveSignalRgbSettings,
  selectSignalRgbAudioEvents,
  SIGNALRGB_SETTINGS_KEY,
} from "../src/plugins/clients/SignalRgbClient";
import type { SignalRgbEventDecisionState } from "../src/plugins/clients/signalrgb/signalRgbTypes";

function eventState(): SignalRgbEventDecisionState {
  return {
    beatLatched: false,
    accentLatched: false,
    lastBeatAt: -Infinity,
    lastAccentAt: -Infinity,
  };
}

describe("SignalRGB settings", () => {
  beforeEach(() => localStorage.clear());

  it("normalizes legacy enabled, styles, colors, and numeric bounds", () => {
    const settings = normalizeSignalRgbSettings({
      enabled: false,
      style: "not-a-style",
      themeColors: ["#ABCDEF", "bad"],
      beatThreshold: 3,
      eventCooldown: 12,
      restoreOnStop: false,
      eventEnhancement: false,
    });

    expect(settings.outputEnabled).toBe(false);
    expect(settings.style).toBe("spectrum-cycle");
    expect(settings.themeColors).toEqual(["#abcdef", "#ff4f79", "#ffd166"]);
    expect(settings.beatThreshold).toBe(1);
    expect(settings.eventCooldown).toBe(80);
    expect(settings.restoreOnStop).toBe(false);
    expect(settings.eventEnhancement).toBe(false);
  });

  it("persists a normalized merge under the SignalRGB key", () => {
    saveSignalRgbSettings({ style: "galaxy", eventCooldown: 255.6 });
    expect(JSON.parse(localStorage.getItem(SIGNALRGB_SETTINGS_KEY) || "null")).toMatchObject({
      style: "galaxy",
      eventCooldown: 256,
      outputEnabled: true,
    });
  });
});

describe("SignalRGB audio event selection", () => {
  it("emits bounded beat strength once until the pulse releases", () => {
    const state = eventState();
    const settings = { beatThreshold: 0.6, eventCooldown: 180 };

    expect(selectSignalRgbAudioEvents({ beat: 0.82, accent: 0 }, settings, state, 1000)).toEqual([
      { kind: "beat", value: "beat:82" },
    ]);
    expect(selectSignalRgbAudioEvents({ beat: 0.9, accent: 0 }, settings, state, 1300)).toEqual([]);
    expect(selectSignalRgbAudioEvents({ beat: 0.1, accent: 0 }, settings, state, 1400)).toEqual([]);
    expect(selectSignalRgbAudioEvents({ beat: 1.5, accent: 0 }, settings, state, 1500)).toEqual([
      { kind: "beat", value: "beat:100" },
    ]);
  });

  it("applies independent cooldowns to beat and accent", () => {
    const state = eventState();
    const settings = { beatThreshold: 0.5, eventCooldown: 300 };

    expect(selectSignalRgbAudioEvents({ beat: 0.7, accent: 0.8 }, settings, state, 1000)).toEqual([
      { kind: "beat", value: "beat:70" },
      { kind: "accent", value: "accent:80" },
    ]);
    selectSignalRgbAudioEvents({ beat: 0, accent: 0 }, settings, state, 1050);
    expect(selectSignalRgbAudioEvents({ beat: 0.9, accent: 0.9 }, settings, state, 1200)).toEqual([]);
    selectSignalRgbAudioEvents({ beat: 0, accent: 0 }, settings, state, 1250);
    expect(selectSignalRgbAudioEvents({ beat: 0.6, accent: 0.6 }, settings, state, 1310)).toHaveLength(2);
  });
});
