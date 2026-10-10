/// <reference types="w3c-web-serial" />

import { NgIcon, provideIcons } from '@ng-icons/core'
import { ESPLoader, Transport, type FlashOptions, type IEspLoaderTerminal } from 'esptool-js'
import {
  lucideActivity,
  lucideCable,
  lucideCircleAlert,
  lucideCircleCheck,
  lucideCpu,
  lucideLoaderCircle,
  lucideRadio,
  lucideRefreshCw,
  lucideTerminal,
  lucideUsb,
  lucideZap,
} from '@ng-icons/lucide'
import { Component, computed, ElementRef, OnInit, signal, ViewChild } from '@angular/core'
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router'

type PrecompiledProfile = 'master' | 'wired' | 'wireless'
type FirmwareMode = 'precompiled' | 'source'
type JobState = 'preparing' | 'connecting' | 'flashing' | 'success' | 'failed'

interface SerialDevice {
  port: SerialPort
  label: string
}

interface JobSnapshot {
  id: string
  profile: PrecompiledProfile
  serialPort: string
  state: JobState
  logs: string[]
  error?: string
}

const precompiledProfileOptions: { id: PrecompiledProfile; name: string; target: string; configuration: string }[] = [
  { id: 'master', name: 'Master', target: 'ESP32 · BLE + radio', configuration: 'BLE BNB-WarDriver · UART1 GPIO17/16 · ESP-NOW channel 1' },
  { id: 'wired', name: 'Wired scanner', target: 'ESP32-C5 · UART', configuration: 'UART1 GPIO8/9 · 921600 baud' },
  { id: 'wireless', name: 'Wireless scanner', target: 'ESP32-C5 · ESP-NOW', configuration: 'ESP-NOW channel 1' },
]

const precompiledImages: Record<PrecompiledProfile, { chip: string; frequency: FlashOptions['flashFreq']; files: { name: string; address: number }[] }> = {
  master: {
    chip: 'ESP32',
    frequency: '40m',
    files: [
      { name: 'bootloader.bin', address: 0x1000 },
      { name: 'partition-table.bin', address: 0x8000 },
      { name: 'app.bin', address: 0x10000 },
    ],
  },
  wired: {
    chip: 'ESP32-C5',
    frequency: '80m',
    files: [
      { name: 'bootloader.bin', address: 0x2000 },
      { name: 'partition-table.bin', address: 0x8000 },
      { name: 'app.bin', address: 0x10000 },
    ],
  },
  wireless: {
    chip: 'ESP32-C5',
    frequency: '80m',
    files: [
      { name: 'bootloader.bin', address: 0x2000 },
      { name: 'partition-table.bin', address: 0x8000 },
      { name: 'app.bin', address: 0x10000 },
    ],
  },
}

const activeStates: JobState[] = ['preparing', 'connecting', 'flashing']

@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './app-shell.html',
})
export class App {}

@Component({
  selector: 'app-flasher-page',
  imports: [NgIcon],
  providers: [provideIcons({
    lucideActivity,
    lucideCable,
    lucideCircleAlert,
    lucideCircleCheck,
    lucideCpu,
    lucideLoaderCircle,
    lucideRadio,
    lucideRefreshCw,
    lucideTerminal,
    lucideUsb,
    lucideZap,
  })],
  templateUrl: './bench.html',
})
export class FlasherPage implements OnInit {
  readonly firmwareMode = signal<FirmwareMode>('precompiled')
  readonly precompiledProfiles = precompiledProfileOptions
  readonly precompiledProfile = signal<PrecompiledProfile>('master')
  readonly loadingPorts = signal(false)
  readonly portError = signal('')
  readonly job = signal<JobSnapshot | null>(null)
  readonly logs = signal<string[]>([])
  readonly requestError = signal('')
  readonly serialSupported = signal(typeof navigator !== 'undefined' && 'serial' in navigator && isSecureContext)
  readonly ready = computed(() => this.serialSupported())
  readonly busy = computed(() => Boolean(this.job() && activeStates.includes(this.job()!.state)))
  readonly selectedPrecompiledProfile = computed(() => this.precompiledProfiles.find((item) => item.id === this.precompiledProfile()) ?? this.precompiledProfiles[0])
  readonly serialPorts = signal<SerialDevice[]>([])
  readonly selectedPortIndex = signal(-1)

  @ViewChild('output') private output?: ElementRef<HTMLPreElement>

  private terminalPending = ''

  ngOnInit() {
    if (this.serialSupported()) void this.refreshPorts()
  }

  async refreshPorts() {
    if (!this.serialSupported()) return
    this.loadingPorts.set(true)
    this.portError.set('')
    try {
      const availablePorts = await navigator.serial.getPorts()
      const nextPorts = availablePorts.map((port) => ({ port, label: this.describePort(port) }))
      this.serialPorts.set(nextPorts)
      const selectedIndex = nextPorts.findIndex((item) => item.port === this.selectedPort())
      const nextIndex = selectedIndex >= 0 ? selectedIndex : nextPorts.length === 1 ? 0 : -1
      this.selectedPortIndex.set(nextIndex)
    } catch (error) {
      this.portError.set(error instanceof Error ? error.message : 'Unable to enumerate permitted serial devices.')
    } finally {
      this.loadingPorts.set(false)
    }
  }

  async requestUsbPort() {
    if (!this.serialSupported() || this.busy()) return
    this.portError.set('')
    try {
      const port = await navigator.serial.requestPort()
      const ports = await navigator.serial.getPorts()
      const nextPorts = ports.map((permittedPort) => ({ port: permittedPort, label: this.describePort(permittedPort) }))
      const selectedIndex = nextPorts.findIndex((item) => item.port === port)
      this.serialPorts.set(nextPorts)
      this.selectedPortIndex.set(selectedIndex)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return
      this.portError.set(error instanceof Error ? error.message : 'Could not access the selected USB serial port.')
    }
  }

  setSerialPort(event: Event) {
    this.selectedPortIndex.set(Number((event.target as HTMLSelectElement).value))
  }

  selectedPort() {
    const index = this.selectedPortIndex()
    return index >= 0 ? this.serialPorts()[index]?.port ?? null : null
  }

  selectedPortLabel() {
    const index = this.selectedPortIndex()
    return index >= 0 ? this.serialPorts()[index]?.label ?? '' : ''
  }

  describePort(port: SerialPort) {
    const info = port.getInfo()
    const vendor = info.usbVendorId?.toString(16).padStart(4, '0')
    const product = info.usbProductId?.toString(16).padStart(4, '0')
    if (vendor && product) return `USB ${vendor}:${product}`
    return 'Serial device'
  }

  setFirmwareMode(mode: FirmwareMode) {
    this.firmwareMode.set(mode)
  }

  setPrecompiledProfile(profile: PrecompiledProfile) {
    this.precompiledProfile.set(profile)
  }

  async flashPrecompiledFirmware() {
    const port = this.selectedPort()
    if (!port || !this.ready() || this.busy()) return

    const selected = this.selectedPrecompiledProfile()
    if (!window.confirm(`Flash precompiled ${selected.name} firmware to ${this.selectedPortLabel()}?`)) return

    this.requestError.set('')
    this.logs.set([])
    this.terminalPending = ''
    const profile = this.precompiledProfile()
    const bundle = precompiledImages[profile]
    const jobId = crypto.randomUUID()
    const initialJob: JobSnapshot = {
      id: jobId,
      profile,
      serialPort: this.selectedPortLabel(),
      state: 'preparing',
      logs: [],
    }
    this.job.set(initialJob)
    this.appendLog(`Selected ${selected.name} · ${bundle.chip}.`)
    this.appendLog(`Requesting ${bundle.files.length} precompiled image(s).`)

    let transport: Transport | undefined
    try {
      const fileArray = await Promise.all(bundle.files.map(async (file) => {
        const url = new URL(`firmwares/${profile}/${file.name}`, document.baseURI)
        this.appendLog(`Loading ${file.name}...`)
        const response = await fetch(url)
        if (!response.ok) throw new Error(`Could not load ${file.name} (HTTP ${response.status}).`)
        return { address: file.address, data: new Uint8Array(await response.arrayBuffer()) }
      }))

      this.appendLog('Connecting to the selected USB serial device...')
      const terminal: IEspLoaderTerminal = {
        clean: () => undefined,
        writeLine: (text) => this.appendTerminalText(`${text}\n`),
        write: (text) => this.appendTerminalText(text),
      }
      transport = new Transport(port)
      const loader = new ESPLoader({ transport, baudrate: 115200, terminal, debugLogging: false })
      const detectedChipDescription = await loader.main()
      const detectedChip = loader.chip.CHIP_NAME
      if (detectedChip !== bundle.chip) {
        throw new Error(`Selected ${selected.name} expects ${bundle.chip}, but detected ${detectedChipDescription}.`)
      }
      this.appendLog(`Detected ${detectedChipDescription}.`)

      this.setJobState('flashing')
      this.appendLog('Writing bootloader, partition table, and application...')
      const flashOptions: FlashOptions = {
        fileArray,
        flashMode: 'dio',
        flashFreq: bundle.frequency,
        flashSize: '4MB',
        eraseAll: false,
        compress: true,
        reportProgress: (fileIndex, written, total) => {
          const file = bundle.files[fileIndex]
          const percent = total === 0 ? 100 : Math.floor((written / total) * 100)
          this.setJobState('flashing')
          this.replaceProgressLog(`${file?.name ?? 'Firmware'}: ${percent}%`)
        },
      }
      await loader.writeFlash(flashOptions)
      this.flushTerminalText()
      await loader.after('hard_reset')
      this.appendLog('Flash verified and device reset.')
      this.setJobState('success')
    } catch (error) {
      this.flushTerminalText()
      const message = error instanceof Error ? error.message : 'Browser flashing failed.'
      this.requestError.set(message)
      this.appendLog(message)
      this.setJobState('failed', message)
    } finally {
      if (transport) {
        await transport.disconnect().catch((error: unknown) => {
          this.appendLog(error instanceof Error ? `Port close: ${error.message}` : 'Port close failed.')
        })
      }
    }
  }

  private appendLog(line: string) {
    this.logs.update((lines) => [...lines, line].slice(-1200))
    this.syncJobLogs()
    this.scrollOutput()
  }

  private appendTerminalText(text: string) {
    this.terminalPending += text
    const chunks = this.terminalPending.split(/\r\n|\n|\r/)
    this.terminalPending = chunks.pop() ?? ''
    for (const chunk of chunks) {
      const line = chunk.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').trim()
      if (line) this.appendLog(line)
    }
  }

  private flushTerminalText() {
    const line = this.terminalPending.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').trim()
    this.terminalPending = ''
    if (line) this.appendLog(line)
  }

  private replaceProgressLog(line: string) {
    this.logs.update((lines) => {
      const next = [...lines]
      let lastIndex = -1
      for (let index = next.length - 1; index >= 0; index--) {
        if (next[index].includes('%')) {
          lastIndex = index
          break
        }
      }
      if (lastIndex >= 0) next[lastIndex] = line
      else next.push(line)
      return next.slice(-1200)
    })
    this.syncJobLogs()
    this.scrollOutput()
  }

  private setJobState(state: JobState, error?: string) {
    this.job.update((job) => job ? { ...job, state, logs: this.logs(), ...(error ? { error } : {}) } : job)
  }

  private syncJobLogs() {
    this.job.update((job) => job ? { ...job, logs: this.logs() } : job)
  }

  private scrollOutput() {
    requestAnimationFrame(() => {
      if (this.output) this.output.nativeElement.scrollTop = this.output.nativeElement.scrollHeight
    })
  }
}
