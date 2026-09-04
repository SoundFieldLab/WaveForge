import {
  CHROMA_DEVICE_METADATA,
  type ChromaDeviceType,
} from "./chromaTypes";

export interface ChromaTopologyDevice {
  type?: string;
  pid?: string | null;
}

export interface ChromaDeviceTopology {
  id: string;
  rows: number;
  columns: number;
  mask: Uint8Array;
}

function coordinateMask(rows: number, columns: number, coordinates: readonly number[]): Uint8Array {
  const mask = new Uint8Array(rows * columns);
  for (const coordinate of coordinates) {
    const row = (coordinate >>> 8) & 0xff;
    const column = coordinate & 0xff;
    if (row < rows && column < columns) mask[row * columns + column] = 1;
  }
  return mask;
}

function fullMask(rows: number, columns: number): Uint8Array {
  return new Uint8Array(rows * columns).fill(1);
}

// Coordinates are from Razer's public RZKEY enum. Wide keys occupy their
// canonical SDK cell; the device firmware maps that cell to the physical LED.
const STANDARD_KEYBOARD_COORDINATES = [
  0x0001, 0x0003, 0x0004, 0x0005, 0x0006, 0x0007, 0x0008, 0x0009,
  0x000a, 0x000b, 0x000c, 0x000d, 0x000e, 0x000f, 0x0010, 0x0011, 0x0014,
  0x0100, 0x0101, 0x0102, 0x0103, 0x0104, 0x0105, 0x0106, 0x0107,
  0x0108, 0x0109, 0x010a, 0x010b, 0x010c, 0x010d, 0x010e, 0x010f,
  0x0110, 0x0111, 0x0112, 0x0113, 0x0114, 0x0115,
  0x0200, 0x0201, 0x0202, 0x0203, 0x0204, 0x0205, 0x0206, 0x0207,
  0x0208, 0x0209, 0x020a, 0x020b, 0x020c, 0x020d, 0x020e, 0x020f,
  0x0210, 0x0211, 0x0212, 0x0213, 0x0214, 0x0215,
  0x0300, 0x0301, 0x0302, 0x0303, 0x0304, 0x0305, 0x0306, 0x0307,
  0x0308, 0x0309, 0x030a, 0x030b, 0x030c, 0x030d, 0x030e, 0x0312,
  0x0313, 0x0314,
  0x0400, 0x0401, 0x0402, 0x0403, 0x0404, 0x0405, 0x0406, 0x0407,
  0x0408, 0x0409, 0x040a, 0x040b, 0x040c, 0x040d, 0x040e, 0x0410,
  0x0412, 0x0413, 0x0414, 0x0415,
  0x0500, 0x0501, 0x0502, 0x0503, 0x0504, 0x0507, 0x0509, 0x050a,
  0x050b, 0x050c, 0x050d, 0x050e, 0x050f, 0x0510, 0x0511, 0x0513,
  0x0514,
] as const;

// Coordinates are from Razer's public Mouse::RZLED2 enum.
const STANDARD_MOUSE_COORDINATES = [
  0x0203, 0x0703, 0x0403,
  0x0100, 0x0200, 0x0300, 0x0400, 0x0500, 0x0600, 0x0700,
  0x0801, 0x0802, 0x0803, 0x0804, 0x0805,
  0x0106, 0x0206, 0x0306, 0x0406, 0x0506, 0x0606, 0x0706,
] as const;

const STANDARD_TOPOLOGIES: Record<ChromaDeviceType, ChromaDeviceTopology> = Object.fromEntries(
  (Object.keys(CHROMA_DEVICE_METADATA) as ChromaDeviceType[]).map((device) => {
    const { rows, columns } = CHROMA_DEVICE_METADATA[device];
    const mask = device === "keyboard"
      ? coordinateMask(rows, columns, STANDARD_KEYBOARD_COORDINATES)
      : device === "mouse"
        ? coordinateMask(rows, columns, STANDARD_MOUSE_COORDINATES)
        : fullMask(rows, columns);
    return [device, { id: `razer-sdk-${device}`, rows, columns, mask }];
  }),
) as Record<ChromaDeviceType, ChromaDeviceTopology>;

const HUNTSMAN_V2_ANALOG_MASK = coordinateMask(6, 22, STANDARD_KEYBOARD_COORDINATES);
for (let row = 1; row < 6; row += 1) HUNTSMAN_V2_ANALOG_MASK[row * 22] = 0;

const MODEL_TOPOLOGIES: Readonly<Record<string, Partial<Record<ChromaDeviceType, ChromaDeviceTopology>>>> = {
  "0266": {
    keyboard: {
      id: "razer-huntsman-v2-analog",
      rows: 6,
      columns: 22,
      mask: HUNTSMAN_V2_ANALOG_MASK,
    },
  },
  "48f0": { mouse: STANDARD_TOPOLOGIES.mouse },
  "0533": { headset: STANDARD_TOPOLOGIES.headset },
  "0f2c": { chromalink: STANDARD_TOPOLOGIES.chromalink },
};

export function getChromaDeviceTopology(
  device: ChromaDeviceType,
  hardwareDevices: readonly ChromaTopologyDevice[] = [],
): ChromaDeviceTopology {
  const matching = hardwareDevices.find((entry) => entry.type === device && entry.pid);
  const pid = matching?.pid?.trim().toLowerCase();
  const requested = pid ? MODEL_TOPOLOGIES[pid]?.[device] : null;
  return requested ?? STANDARD_TOPOLOGIES[device];
}

export function applyChromaTopologyMask(
  frame: Uint32Array,
  topology: ChromaDeviceTopology,
): Uint32Array {
  const length = Math.min(frame.length, topology.mask.length);
  for (let index = 0; index < length; index += 1) {
    if (topology.mask[index] === 0) frame[index] = 0;
  }
  return frame;
}
