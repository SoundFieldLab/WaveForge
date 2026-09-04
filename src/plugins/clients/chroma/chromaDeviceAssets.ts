const RAZER_DEVICE_IMAGES: Readonly<Record<string, string>> = {
  '00a4': '/chroma-devices/00a4.png',
  '0266': '/chroma-devices/0266.png',
  '0533': '/chroma-devices/0533.png',
  '0f1d': '/chroma-devices/0f1d.png',
  '0f20': '/chroma-devices/0f20.png',
  '48f0': '/chroma-devices/48f0.png',
}

export function getRazerDeviceImage(pid: string | null): string | null {
  if (!pid) return null
  return RAZER_DEVICE_IMAGES[pid.trim().toLowerCase()] ?? null
}
