import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SerialPort } from 'serialport'
import { z } from 'zod'

const firmwareRoot = resolve(process.env.FIRMWARE_ROOT ?? resolve(process.cwd(), '../BNBDriverMaster'))
const idfPath = resolve(process.env.IDF_PATH ?? join(homedir(), '.espressif/v6.1/esp-idf'))

const profiles = {
  master: { project: 'master_node', target: 'esp32', label: 'Master · ESP32' },
  'scanner-uart': { project: 'wifi_scanner_c5', target: 'esp32c5', label: 'Scanner · UART' },
  'scanner-espnow': { project: 'wifi_scanner_c5', target: 'esp32c5', label: 'Scanner · ESP-NOW' },
} as const

const gpio = z.number().int().min(0).max(48)
const uartPort = z.number().int().min(0).max(2)
const baudRate = z.union([
  z.literal(115200),
  z.literal(230400),
  z.literal(460800),
  z.literal(921600),
])
const channel = z.number().int().min(1).max(13)
const serialPath = z.string().min(1).max(256)

const masterSettings = z.object({
  bleDeviceName: z.string().trim().min(1).max(31).regex(/^[A-Za-z0-9 _-]+$/),
  uartPort,
  txGpio: gpio,
  rxGpio: gpio,
  baudRate,
  espnowChannel: channel,
})

const scannerUartSettings = z.object({
  uartPort,
  txGpio: gpio,
  rxGpio: gpio,
  baudRate,
})

const scannerEspnowSettings = z.object({ espnowChannel: channel })

export const flashRequestSchema = z.discriminatedUnion('profile', [
  z.object({ profile: z.literal('master'), serialPort: serialPath, settings: masterSettings }),
  z.object({ profile: z.literal('scanner-uart'), serialPort: serialPath, settings: scannerUartSettings }),
  z.object({ profile: z.literal('scanner-espnow'), serialPort: serialPath, settings: scannerEspnowSettings }),
]).superRefine((request, context) => {
  if (request.profile === 'master' || request.profile === 'scanner-uart') {
    if (request.settings.txGpio === request.settings.rxGpio) {
      context.addIssue({ code: 'custom', path: ['settings', 'rxGpio'], message: 'TX and RX pins must differ.' })
    }
    const maxGpio = request.profile === 'master' ? 39 : 28
    if (request.settings.txGpio > maxGpio || request.settings.rxGpio > maxGpio) {
      context.addIssue({ code: 'custom', path: ['settings'], message: `GPIO must be between 0 and ${maxGpio} for this board.` })
    }
  }
})

export type FlashRequest = z.infer<typeof flashRequestSchema>
export type JobState = 'preparing' | 'configuring' | 'building' | 'flashing' | 'success' | 'failed'

export interface JobSnapshot {
  id: string
  profile: FlashRequest['profile']
  serialPort: string
  state: JobState
  logs: string[]
  error?: string
}

interface Job extends JobSnapshot {
  workDirectory: string
  subscribers: Set<(snapshot: JobSnapshot) => void>
}

export class FlasherError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message)
  }
}

const jobs = new Map<string, Job>()
let activeJobId: string | undefined

export function getSystemStatus() {
  const masterProject = join(firmwareRoot, profiles.master.project)
  const scannerProject = join(firmwareRoot, profiles['scanner-uart'].project)
  const idfReady = existsSync(join(idfPath, 'export.sh'))
  const firmwareReady = existsSync(join(masterProject, 'CMakeLists.txt'))
    && existsSync(join(scannerProject, 'CMakeLists.txt'))
    && existsSync(join(firmwareRoot, 'components/wardrive_proto/CMakeLists.txt'))

  return {
    idfReady,
    firmwareReady,
    idfPath,
    firmwareRoot,
    busy: Boolean(activeJobId),
  }
}

export async function listSerialPorts() {
  const ports = await SerialPort.list()
  return ports.filter((port) => {
    const path = port.path.toLowerCase()
    if (process.platform === 'linux') {
      return /^\/dev\/(ttyusb\d+|ttyacm\d+)$/.test(path) || path.startsWith('/dev/serial/by-id/')
    }
    if (process.platform === 'darwin') return path.includes('.usb') || Boolean(port.vendorId)
    return Boolean(port.vendorId || port.pnpId?.toLowerCase().includes('usb'))
  })
}

function snapshot(job: Job): JobSnapshot {
  return {
    id: job.id,
    profile: job.profile,
    serialPort: job.serialPort,
    state: job.state,
    logs: [...job.logs],
    ...(job.error ? { error: job.error } : {}),
  }
}

function publish(job: Job) {
  const update = snapshot(job)
  for (const subscriber of job.subscribers) subscriber(update)
}

function log(job: Job, line: string) {
  job.logs.push(line)
  if (job.logs.length > 1200) job.logs.splice(0, job.logs.length - 1200)
  publish(job)
}

export function cleanTerminalOutput(text: string) {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u009B[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B[@-_]/g, '')
    .replace(/[\u2500-\u259F]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\u001B/g, '')
}

function replaceSdkconfigValue(contents: string, key: string, value: string) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^(?:${escapedKey}=.*|# ${escapedKey} is not set)$`)
  const lines = contents.split(/\r?\n/)
  let found = false
  const updated = lines.flatMap((line) => {
    if (!pattern.test(line)) return [line]
    if (found) return []
    found = true
    return [value]
  })

  if (!found) updated.push(value)
  return updated.join('\n')
}

export function renderSdkconfig(contents: string, request: FlashRequest) {
  let configured = contents

  if (request.profile === 'master') {
    const settings = request.settings
    configured = replaceSdkconfigValue(configured, 'CONFIG_WD_BLE_DEVICE_NAME', `CONFIG_WD_BLE_DEVICE_NAME="${settings.bleDeviceName}"`)
    configured = replaceSdkconfigValue(configured, 'CONFIG_WD_MASTER_UART_PORT_NUM', `CONFIG_WD_MASTER_UART_PORT_NUM=${settings.uartPort}`)
    configured = replaceSdkconfigValue(configured, 'CONFIG_WD_MASTER_UART_TX_GPIO', `CONFIG_WD_MASTER_UART_TX_GPIO=${settings.txGpio}`)
    configured = replaceSdkconfigValue(configured, 'CONFIG_WD_MASTER_UART_RX_GPIO', `CONFIG_WD_MASTER_UART_RX_GPIO=${settings.rxGpio}`)
    configured = replaceSdkconfigValue(configured, 'CONFIG_WD_MASTER_UART_BAUD', `CONFIG_WD_MASTER_UART_BAUD=${settings.baudRate}`)
    configured = replaceSdkconfigValue(configured, 'CONFIG_WD_MASTER_ESPNOW_CHANNEL', `CONFIG_WD_MASTER_ESPNOW_CHANNEL=${settings.espnowChannel}`)
  } else if (request.profile === 'scanner-uart') {
    const settings = request.settings
    configured = replaceSdkconfigValue(configured, 'CONFIG_WD_TRANSPORT_UART', 'CONFIG_WD_TRANSPORT_UART=y')
    configured = replaceSdkconfigValue(configured, 'CONFIG_WD_TRANSPORT_ESPNOW', '# CONFIG_WD_TRANSPORT_ESPNOW is not set')
    configured = replaceSdkconfigValue(configured, 'CONFIG_WD_UART_PORT_NUM', `CONFIG_WD_UART_PORT_NUM=${settings.uartPort}`)
    configured = replaceSdkconfigValue(configured, 'CONFIG_WD_UART_TX_GPIO', `CONFIG_WD_UART_TX_GPIO=${settings.txGpio}`)
    configured = replaceSdkconfigValue(configured, 'CONFIG_WD_UART_RX_GPIO', `CONFIG_WD_UART_RX_GPIO=${settings.rxGpio}`)
    configured = replaceSdkconfigValue(configured, 'CONFIG_WD_UART_BAUD', `CONFIG_WD_UART_BAUD=${settings.baudRate}`)
  } else {
    configured = replaceSdkconfigValue(configured, 'CONFIG_WD_TRANSPORT_UART', '# CONFIG_WD_TRANSPORT_UART is not set')
    configured = replaceSdkconfigValue(configured, 'CONFIG_WD_TRANSPORT_ESPNOW', 'CONFIG_WD_TRANSPORT_ESPNOW=y')
    configured = replaceSdkconfigValue(configured, 'CONFIG_WD_ESPNOW_CHANNEL', `CONFIG_WD_ESPNOW_CHANNEL=${request.settings.espnowChannel}`)
  }

  return `${configured.replace(/\n*$/, '')}\n`
}

function runIdf(job: Job, projectDirectory: string, args: string[]) {
  return new Promise<void>((resolveRun, rejectRun) => {
    const command = 'source "$1/export.sh" && shift && exec idf.py "$@"'
    const child = spawn('bash', [
      '--noprofile', '--norc', '-c', command, 'bnb-idf', idfPath, ...args,
    ], {
      cwd: projectDirectory,
      env: { ...process.env, IDF_PATH: idfPath },
    })

    let pending = ''
    const consume = (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      const lines = pending.split(/\r\n|\n|\r/)
      pending = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = cleanTerminalOutput(rawLine).trimEnd()
        if (line.trim()) log(job, line)
      }
    }

    child.stdout.on('data', consume)
    child.stderr.on('data', consume)
    child.on('error', (error) => rejectRun(error))
    child.on('close', (code) => {
      const finalLine = cleanTerminalOutput(pending).trimEnd()
      if (finalLine.trim()) log(job, finalLine)
      if (code === 0) resolveRun()
      else rejectRun(new Error(`idf.py exited with code ${code ?? 'unknown'}.`))
    })
  })
}

function pruneJobs() {
  const completed = [...jobs.values()]
    .filter((job) => job.state === 'success' || job.state === 'failed')
    .slice(0, Math.max(0, jobs.size - 12))
  for (const job of completed) jobs.delete(job.id)
}

export async function startFlash(request: FlashRequest) {
  if (activeJobId) throw new FlasherError('A build or flash job is already running.', 409)

  const status = getSystemStatus()
  if (!status.idfReady) throw new FlasherError(`ESP-IDF was not found at ${idfPath}. Set IDF_PATH to your ESP-IDF installation.`, 503)
  if (!status.firmwareReady) throw new FlasherError(`Firmware projects were not found under ${firmwareRoot}. Set FIRMWARE_ROOT to the BNBDriverMaster directory.`, 503)

  const availablePorts = await listSerialPorts()
  if (!availablePorts.some((port) => port.path === request.serialPort)) {
    throw new FlasherError('That serial port is no longer available. Refresh the device list and try again.', 409)
  }

  const profile = profiles[request.profile]
  const projectDirectory = join(firmwareRoot, profile.project)
  const sourceConfigPath = join(projectDirectory, 'sdkconfig')
  const baseConfig = await readFile(sourceConfigPath, 'utf8').catch(() => '')
  if (!baseConfig) throw new FlasherError(`Could not read the firmware configuration at ${sourceConfigPath}.`, 500)

  const workDirectory = await mkdtemp(join(tmpdir(), 'bnb-flasher-'))
  const sdkconfigPath = join(workDirectory, 'sdkconfig')
  await writeFile(sdkconfigPath, renderSdkconfig(baseConfig, request), 'utf8')

  pruneJobs()
  const job: Job = {
    id: randomUUID(),
    profile: request.profile,
    serialPort: request.serialPort,
    state: 'preparing',
    logs: [`${profile.label} selected for ${request.serialPort}.`, 'Using an isolated SDK configuration and build directory.'],
    workDirectory,
    subscribers: new Set(),
  }
  jobs.set(job.id, job)
  activeJobId = job.id
  publish(job)
  void executeJob(job, profile.target, projectDirectory, sdkconfigPath, workDirectory, request.serialPort)
  return snapshot(job)
}

async function executeJob(
  job: Job,
  target: string,
  projectDirectory: string,
  sdkconfigPath: string,
  workDirectory: string,
  serialPort: string,
) {
  const buildDirectory = join(workDirectory, 'build')
  const sharedArgs = ['--build-dir', buildDirectory, '--define-cache-entry', `SDKCONFIG=${sdkconfigPath}`]

  try {
    job.state = 'configuring'
    log(job, `Configuring ESP-IDF target ${target}...`)
    await runIdf(job, projectDirectory, [...sharedArgs, 'set-target', target])

    job.state = 'building'
    log(job, 'Building firmware...')
    await runIdf(job, projectDirectory, [...sharedArgs, 'build'])

    job.state = 'flashing'
    log(job, `Flashing ${serialPort}...`)
    await runIdf(job, projectDirectory, [...sharedArgs, '--port', serialPort, 'flash'])

    job.state = 'success'
    log(job, 'Flash completed successfully.')
  } catch (error) {
    job.state = 'failed'
    job.error = error instanceof Error ? error.message : 'An unexpected flasher error occurred.'
    log(job, job.error)
  } finally {
    await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined)
    if (activeJobId === job.id) activeJobId = undefined
    publish(job)
  }
}

export function getJob(jobId: string) {
  const job = jobs.get(jobId)
  return job ? snapshot(job) : undefined
}

export function subscribeToJob(jobId: string, subscriber: (update: JobSnapshot) => void) {
  const job = jobs.get(jobId)
  if (!job) return () => undefined
  job.subscribers.add(subscriber)
  return () => job.subscribers.delete(subscriber)
}

export function getProfileLabel(profile: FlashRequest['profile']) {
  return profiles[profile].label
}