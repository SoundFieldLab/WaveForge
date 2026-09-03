import type { ChromaDeviceType } from "./chromaTypes";
import type { ChromaDeviceTopology } from "./chromaTopology";

export const CHROMA_VISUALIZER_WIDTH = 256;
export const CHROMA_VISUALIZER_HEIGHT = 64;
export const CHROMA_VISUALIZER_STRIP_ROW = 0;
export const CHROMA_VISUALIZER_FIELD_TOP = 1;

export interface ChromaVisualizerField {
  width: typeof CHROMA_VISUALIZER_WIDTH;
  height: typeof CHROMA_VISUALIZER_HEIGHT;
  colors: Uint32Array;
  coverage: Float32Array;
}

const sampleCoordinate = (index: number, count: number, size: number) =>
  count <= 1 ? Math.floor((size - 1) / 2) : Math.round((index / (count - 1)) * (size - 1));

export function createChromaVisualizerField(): ChromaVisualizerField {
  return {
    width: CHROMA_VISUALIZER_WIDTH,
    height: CHROMA_VISUALIZER_HEIGHT,
    colors: new Uint32Array(CHROMA_VISUALIZER_WIDTH * CHROMA_VISUALIZER_HEIGHT),
    coverage: new Float32Array(CHROMA_VISUALIZER_WIDTH * CHROMA_VISUALIZER_HEIGHT),
  };
}

export function sampleVisualizerField(
  field: ChromaVisualizerField,
  x: number,
  y: number,
): number {
  const column = Math.max(0, Math.min(field.width - 1, Math.round(x)));
  const row = Math.max(0, Math.min(field.height - 1, Math.round(y)));
  return field.colors[row * field.width + column] ?? 0;
}

const projectionScale = (size: number) => {
  const normalized = Math.max(1, Math.min(10, Number.isFinite(size) ? size : 5));
  const gainDb = normalized <= 5
    ? -18 + (normalized - 1) * 4.5
    : (normalized - 5) * 3;
  return 10 ** (gainDb / 20);
};

export function projectVisualizerField2D(
  field: ChromaVisualizerField,
  topology: ChromaDeviceTopology,
  size = 5,
): Uint32Array {
  const output = new Uint32Array(topology.rows * topology.columns);
  const fieldRows = field.height - CHROMA_VISUALIZER_FIELD_TOP;
  const scale = projectionScale(size);
  for (let row = 0; row < topology.rows; row += 1) {
    const normalizedHeight = topology.rows <= 1 ? 0 : (topology.rows - 1 - row) / (topology.rows - 1);
    const scaledHeight = Math.max(0, Math.min(1, normalizedHeight / scale));
    const sourceRow = CHROMA_VISUALIZER_FIELD_TOP + Math.round((1 - scaledHeight) * (fieldRows - 1));
    for (let column = 0; column < topology.columns; column += 1) {
      const target = row * topology.columns + column;
      if (topology.mask[target] === 0) continue;
      const sourceColumn = sampleCoordinate(column, topology.columns, field.width);
      output[target] = sampleVisualizerField(field, sourceColumn, sourceRow);
    }
  }
  return output;
}

export function projectVisualizerField1D(
  field: ChromaVisualizerField,
  topology: ChromaDeviceTopology,
  size = 5,
): Uint32Array {
  const output = new Uint32Array(topology.rows * topology.columns);
  const scale = projectionScale(size);
  for (let index = 0; index < output.length; index += 1) {
    if (topology.mask[index] === 0) continue;
    const outputPosition = output.length <= 1 ? 0 : index / (output.length - 1);
    const sourcePosition = outputPosition / scale;
    if (sourcePosition > 1) continue;
    const sourceColumn = Math.round(sourcePosition * (field.width - 1));
    output[index] = sampleVisualizerField(field, sourceColumn, CHROMA_VISUALIZER_STRIP_ROW);
  }
  return output;
}

export function projectVisualizerCoverage2D(
  field: ChromaVisualizerField,
  topology: ChromaDeviceTopology,
  size = 5,
): Float32Array {
  const output = new Float32Array(topology.rows * topology.columns);
  const fieldRows = field.height - CHROMA_VISUALIZER_FIELD_TOP;
  const scale = projectionScale(size);
  for (let row = 0; row < topology.rows; row += 1) {
    const normalizedHeight = topology.rows <= 1 ? 0 : (topology.rows - 1 - row) / (topology.rows - 1);
    const scaledHeight = Math.max(0, Math.min(1, normalizedHeight / scale));
    const sourceRow = CHROMA_VISUALIZER_FIELD_TOP + Math.round((1 - scaledHeight) * (fieldRows - 1));
    for (let column = 0; column < topology.columns; column += 1) {
      const target = row * topology.columns + column;
      if (topology.mask[target] === 0) continue;
      const sourceColumn = sampleCoordinate(column, topology.columns, field.width);
      output[target] = field.coverage[sourceRow * field.width + sourceColumn] ?? 0;
    }
  }
  return output;
}

export function projectVisualizerCoverage1D(
  field: ChromaVisualizerField,
  topology: ChromaDeviceTopology,
  size = 5,
): Float32Array {
  const output = new Float32Array(topology.rows * topology.columns);
  const scale = projectionScale(size);
  for (let index = 0; index < output.length; index += 1) {
    if (topology.mask[index] === 0) continue;
    const outputPosition = output.length <= 1 ? 0 : index / (output.length - 1);
    const sourcePosition = outputPosition / scale;
    if (sourcePosition > 1) continue;
    const sourceColumn = Math.round(sourcePosition * (field.width - 1));
    output[index] = field.coverage[sourceColumn] ?? 0;
  }
  return output;
}

export function projectVisualizerCoverage(
  device: ChromaDeviceType,
  field: ChromaVisualizerField,
  topology: ChromaDeviceTopology,
  size = 5,
): Float32Array {
  return device === "mousepad" || device === "headset" || device === "chromalink"
    ? projectVisualizerCoverage1D(field, topology, size)
    : projectVisualizerCoverage2D(field, topology, size);
}

export function projectVisualizerField(
  device: ChromaDeviceType,
  field: ChromaVisualizerField,
  topology: ChromaDeviceTopology,
  size = 5,
): Uint32Array {
  return device === "mousepad" || device === "headset" || device === "chromalink"
    ? projectVisualizerField1D(field, topology, size)
    : projectVisualizerField2D(field, topology, size);
}
