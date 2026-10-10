import { NgIcon, provideIcons } from '@ng-icons/core'
import { FormsModule } from '@angular/forms'
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
import { Component, computed, DestroyRef, ElementRef, inject, OnInit, signal, ViewChild } from '@angular/core'

type Profile = 'master' | 'scanner-uart' | 'scanner-espnow'
type JobState = 'preparing' | 'configuring' | 'building' | 'flashing' | 'success' | 'failed'
type UartField = 'uartPort' | 'txGpio' | 'rxGpio' | 'baudRate'
type MasterNumberField = UartField | 'espnowChannel'

interface SerialDevice {
  path: string
  manufacturer?: string
  friendlyName?: string
  vendorId?: string
  productId?: string
}

interface SystemStatus {
  idfReady: boolean
  firmwareReady: boolean
  idfPath: string
  firmwareRoot: string
  busy: boolean
}

interface JobSnapshot {
  id: string
  profile: Profile
  serialPort: string
  state: JobState
  logs: string[]
  error?: string
}

interface MasterSettings {
  bleDeviceName: string
  uartPort: number
  txGpio: number
  rxGpio: number
  baudRate: number
  espnowChannel: number
}

interface UartSettings {
  uartPort: number
  txGpio: number
  rxGpio: number
  baudRate: number
}

const profileOptions: { id: Profile; name: string; target: string }[] = [
  { id: 'master', name: 'Master', target: 'ESP32 · BLE + radio' },
  { id: 'scanner-uart', name: 'Wired scanner', target: 'ESP32-C5 · UART' },
  { id: 'scanner-espnow', name: 'Wireless scanner', target: 'ESP32-C5 · ESP-NOW' },
]

const baudRates = [115200, 230400, 460800, 921600]
const activeStates: JobState[] = ['preparing', 'configuring', 'building', 'flashing']

@Component({
  selector: 'app-root',
  imports: [FormsModule, NgIcon],
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
export class App implements OnInit {
  readonly profiles = profileOptions
  readonly baudRates = baudRates
  readonly profile = signal<Profile>('master')
  readonly masterSettings = signal<MasterSettings>({
    bleDeviceName: 'BNB-WarDriver',
    uartPort: 1,
    txGpio: 17,
    rxGpio: 16,
    baudRate: 921600,
    espnowChannel: 1,
  })
  readonly scannerSettings = signal<UartSettings>({ uartPort: 1, txGpio: 8, rxGpio: 9, baudRate: 921600 })
  readonly scannerChannel = signal(1)
  readonly ports = signal<SerialDevice[]>([])
  readonly serialPort = signal('')
  readonly loadingPorts = signal(false)
  readonly portError = signal('')
  readonly systemStatus = signal<SystemStatus | null>(null)
  readonly job = signal<JobSnapshot | null>(null)
  readonly logs = signal<string[]>([])
  readonly requestError = signal('')
  readonly ready = computed(() => Boolean(this.systemStatus()?.idfReady && this.systemStatus()?.firmwareReady))
  readonly busy = computed(() => Boolean(this.systemStatus()?.busy)
    || Boolean(this.job() && activeStates.includes(this.job()!.state)))
  readonly selectedProfile = computed(() => this.profiles.find((item) => item.id === this.profile()) ?? this.profiles[0])

  @ViewChild('output') private output?: ElementRef<HTMLPreElement>

  private readonly destroyRef = inject(DestroyRef)
  private events?: EventSource

  constructor() {
    this.destroyRef.onDestroy(() => this.events?.close())
  }

  ngOnInit() {
    void this.loadInitialState()
  }

  async refreshPorts() {
    this.loadingPorts.set(true)
    this.portError.set('')
    try {
      const response = await fetch('/api/ports')
      if (!response.ok) throw new Error('Unable to read serial devices.')
      const availablePorts = await response.json() as SerialDevice[]
      this.ports.set(availablePorts)
      const current = this.serialPort()
      this.serialPort.set(availablePorts.some((item) => item.path === current)
        ? current
        : availablePorts[0]?.path ?? '')
    } catch (error) {
      this.portError.set(error instanceof Error ? error.message : 'Unable to read serial devices.')
    } finally {
      this.loadingPorts.set(false)
    }
  }

  setProfile(profile: Profile) {
    this.profile.set(profile)
  }

  setBleName(event: Event) {
    const value = (event.target as HTMLInputElement).value
    this.masterSettings.update((settings) => ({ ...settings, bleDeviceName: value }))
  }

  setMasterNumber(field: MasterNumberField, event: Event) {
    const value = Number((event.target as HTMLInputElement).value)
    this.masterSettings.update((settings) => ({ ...settings, [field]: value }))
  }

  setMasterSelect(field: 'uartPort' | 'baudRate', value: number) {
    this.masterSettings.update((settings) => ({ ...settings, [field]: value }))
  }

  setScannerNumber(field: UartField, event: Event) {
    const value = Number((event.target as HTMLInputElement).value)
    this.scannerSettings.update((settings) => ({ ...settings, [field]: value }))
  }

  setScannerSelect(field: 'uartPort' | 'baudRate', value: number) {
    this.scannerSettings.update((settings) => ({ ...settings, [field]: value }))
  }

  setScannerChannel(event: Event) {
    this.scannerChannel.set(Number((event.target as HTMLInputElement).value))
  }

  setSerialPort(event: Event) {
    this.serialPort.set((event.target as HTMLSelectElement).value)
  }

  async flashFirmware(event: Event) {
    event.preventDefault()
    if (!this.serialPort() || !this.ready() || this.busy()) return

    const selected = this.selectedProfile()
    if (!window.confirm(`Build and flash ${selected.name} to ${this.serialPort()}?`)) return

    const profile = this.profile()
    const settings = profile === 'master'
      ? this.masterSettings()
      : profile === 'scanner-uart'
        ? this.scannerSettings()
        : { espnowChannel: this.scannerChannel() }

    this.requestError.set('')
    this.logs.set([])
    this.job.set(null)
    this.events?.close()

    try {
      const response = await fetch('/api/flash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile, serialPort: this.serialPort(), settings }),
      })
      const result = await response.json() as JobSnapshot & { error?: string }
      if (!response.ok) throw new Error(result.error ?? 'Could not start the flash job.')

      this.job.set(result)
      this.logs.set(result.logs)
      this.scrollOutput()
      this.events = new EventSource(`/api/jobs/${result.id}/events`)
      this.events.onmessage = (message) => {
        const update = JSON.parse(message.data) as JobSnapshot
        this.job.set(update)
        this.logs.set(update.logs)
        this.scrollOutput()
        if (update.state === 'success' || update.state === 'failed') this.events?.close()
      }
    } catch (error) {
      this.requestError.set(error instanceof Error ? error.message : 'Could not start the flash job.')
    }
  }

  basename(path: string) {
    return path.split('/').filter(Boolean).at(-1) ?? path
  }

  private async loadInitialState() {
    try {
      const [statusResponse, portsResponse] = await Promise.all([
        fetch('/api/status'),
        fetch('/api/ports'),
      ])
      if (!statusResponse.ok || !portsResponse.ok) throw new Error('The local flasher service is unavailable.')
      const status = await statusResponse.json() as SystemStatus
      const availablePorts = await portsResponse.json() as SerialDevice[]
      this.systemStatus.set(status)
      this.ports.set(availablePorts)
      this.serialPort.set(availablePorts[0]?.path ?? '')
    } catch (error) {
      this.requestError.set(error instanceof Error ? error.message : 'Could not reach the flasher service.')
    }
  }

  private scrollOutput() {
    requestAnimationFrame(() => {
      if (this.output) this.output.nativeElement.scrollTop = this.output.nativeElement.scrollHeight
    })
  }
}
