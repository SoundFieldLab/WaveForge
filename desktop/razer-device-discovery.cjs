'use strict'

const { execFile } = require('node:child_process')

const RAZER_VENDOR_ID = '1532'
const DISCOVERY_TIMEOUT_MS = 4000

const PID_TYPES = Object.freeze({
  '0067': 'keyboard',
  '0084': 'keyboard',
  '0091': 'keyboard',
  '0098': 'keyboard',
  '0266': 'keyboard',
  '0203': 'mouse',
  '005C': 'mouse',
  '007A': 'mouse',
  '00E1': 'mouse',
  '00A4': 'unknown',
  '0C00': 'mousepad',
  '0504': 'headset',
  '0515': 'headset',
  '0533': 'headset',
  '48F0': 'mouse',
  '0113': 'keypad',
  '0F1D': 'unknown',
  '0F20': 'unknown',
  '0F1F': 'chromalink',
  '0F2C': 'chromalink',
})

const PID_MODELS = Object.freeze({
  '0266': 'Razer Huntsman V2 Analog',
  '0533': 'Razer Kraken V3 HyperSense',
  '48F0': 'Razer Basilisk V3 Pro',
  '00A4': 'Razer Mouse Dock Pro',
  '0F1D': 'Razer Mouse Bungee V3 Chroma',
  '0F20': 'Razer Base Station V2 Chroma',
  '0F2C': 'Razer Chroma Wireless ARGB Controller',
})

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  $filter = "Manufacturer LIKE '%Razer%' OR Name LIKE '%Razer%' OR PNPDeviceID LIKE '%VID_1532%'"
  $devices = Get-CimInstance Win32_PnPEntity -Filter $filter | Where-Object { $_.Present -ne $false } | Select-Object Name, @{n='FriendlyName';e={$_.Name}}, Manufacturer, @{n='Class';e={$_.PNPClass}}, @{n='InstanceId';e={$_.PNPDeviceID}}, PNPDeviceID, Present, Status, @{n='Source';e={'Win32_PnPEntity'}}
} catch {
  $devices = Get-PnpDevice -PresentOnly -InstanceId '*VID_1532*' | Select-Object @{n='Name';e={$_.FriendlyName}}, FriendlyName, Manufacturer, Class, InstanceId, @{n='PNPDeviceID';e={$_.InstanceId}}, Present, Status, @{n='Source';e={'Get-PnpDevice'}}
}
@($devices) | ConvertTo-Json -Depth 3 -Compress
`.trim()

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function extractHardwareIds(device) {
  const instanceId = text(device.InstanceId || device.PNPDeviceID)
  const vid = instanceId.match(/VID_([0-9A-F]{4})/i)?.[1]?.toUpperCase() || null
  const pid = instanceId.match(/PID_([0-9A-F]{4})/i)?.[1]?.toUpperCase() || null
  return { instanceId, vid, pid }
}

function isRazerDevice(device, ids) {
  return /razer/i.test(text(device.Manufacturer))
    || /razer/i.test(text(device.FriendlyName || device.Name))
    || ids.vid === RAZER_VENDOR_ID
}

function isInterfaceNoise(name, deviceClass) {
  const value = text(name)
  const generic = /^(?:hid(?:-compliant| keyboard) .+|hid keyboard device|usb input device|usb composite device|razer control device|razer chroma sdk|consumer control device|USB \u8F93\u5165\u8BBE\u5907|\u7B26\u5408 HID \u6807\u51C6.+)$/i.test(value)
  const interfaceOnly = /(?:interface|composite device|control device)$/i.test(value)
  return generic || (interfaceOnly && /^(?:hidclass|usb|system)$/i.test(text(deviceClass)))
}

function classifyDevice(name, deviceClass, pid) {
  const value = text(name).toLowerCase()
  if (/mouse\s*pad|firefly|strider|goliathus|acari/.test(value)) return 'mousepad'
  if (/headset|headphone|kraken|blackshark|barracuda|nari|man(?:o|')war|thresher|electra/.test(value)) return 'headset'
  if (/keypad|tartarus|orbweaver|nostromo/.test(value)) return 'keypad'
  if (/chromalink|chroma link|addressable rgb|argb controller/.test(value)) return 'chromalink'
  if (/base station|mouse bungee|mouse dock/.test(value)) return 'unknown'
  if (/keyboard|blackwidow|huntsman|ornata|cynosa|deathstalker|anansi/.test(value)) return 'keyboard'
  if (/mouse|deathadder|basilisk|viper|naga|orochi|cobra|mamba|lancehead|abyssus|diamondback/.test(value)) return 'mouse'
  if (pid && PID_TYPES[pid]) return PID_TYPES[pid]
  if (/keyboard/i.test(text(deviceClass))) return 'keyboard'
  if (/mouse/i.test(text(deviceClass))) return 'mouse'
  return 'unknown'
}

function normalizeModelName(device, ids) {
  if (ids.pid && PID_MODELS[ids.pid]) return PID_MODELS[ids.pid]
  const choices = [device.FriendlyName, device.Name].map(text).filter(Boolean)
  const named = choices.find((name) => /razer/i.test(name) && !isInterfaceNoise(name, device.Class))
    || choices.find((name) => !isInterfaceNoise(name, device.Class))
  if (named) return named.replace(/\s+/g, ' ').trim()
  if (ids.pid) return `Razer device (${ids.vid || RAZER_VENDOR_ID}:${ids.pid})`
  return 'Razer device'
}

function parsePnpDevices(raw) {
  let parsed = raw
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/^\uFEFF/, '').trim()
    if (!cleaned) return []
    parsed = JSON.parse(cleaned)
  }
  const records = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : []
  const candidates = []

  for (const device of records) {
    if (!device || typeof device !== 'object') continue
    const ids = extractHardwareIds(device)
    if (/^(?:SWD|ROOT)\\/i.test(ids.instanceId)) continue
    if (!isRazerDevice(device, ids)) continue
    const rawName = text(device.FriendlyName || device.Name)
    const mappedModel = ids.pid ? PID_MODELS[ids.pid] : null
    if (!mappedModel && isInterfaceNoise(rawName, device.Class)) continue
    const name = normalizeModelName(device, ids)
    const present = device.Present === undefined || device.Present === null
      ? !/^(?:error|unknown|degraded)$/i.test(text(device.Status))
      : device.Present !== false
    candidates.push({
      id: ids.instanceId || `${ids.vid || RAZER_VENDOR_ID}:${ids.pid || 'UNKNOWN'}:${name}`,
      name,
      type: classifyDevice(name, device.Class, ids.pid),
      present,
      vid: ids.vid,
      pid: ids.pid,
      source: text(device.Source) || 'Windows PnP',
      _noise: isInterfaceNoise(text(device.FriendlyName || device.Name), device.Class),
    })
  }

  const unique = new Map()
  for (const candidate of candidates) {
    const productKey = candidate.vid && candidate.pid
      ? `${candidate.vid}:${candidate.pid}:${candidate.name.toLowerCase().replace(/\s+(?:interface|device)$/i, '')}`
      : candidate.id.toLowerCase()
    const current = unique.get(productKey)
    if (!current || (current.type === 'unknown' && candidate.type !== 'unknown') || (current._noise && !candidate._noise)) {
      unique.set(productKey, candidate)
    }
  }

  return Array.from(unique.values(), ({ _noise, ...device }) => device)
    .sort((left, right) => left.name.localeCompare(right.name))
}

function runPowerShell() {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', POWERSHELL_SCRIPT,
    ], {
      encoding: 'utf8',
      timeout: DISCOVERY_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = text(stderr) || error.message
        reject(new Error(error.killed ? `Windows device scan timed out after ${DISCOVERY_TIMEOUT_MS}ms` : detail))
        return
      }
      resolve(stdout)
    })
  })
}

async function discoverDevices() {
  if (process.platform !== 'win32') return { devices: [], diagnostic: null }
  try {
    return { devices: parsePnpDevices(await runPowerShell()), diagnostic: null }
  } catch (error) {
    return { devices: [], diagnostic: error instanceof Error ? error.message : String(error) }
  }
}

module.exports = {
  DISCOVERY_TIMEOUT_MS,
  PID_MODELS,
  PID_TYPES,
  discoverDevices,
  parsePnpDevices,
}
