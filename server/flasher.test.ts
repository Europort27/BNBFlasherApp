import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanTerminalOutput, flashRequestSchema, renderSdkconfig } from './flasher.js'

const existingConfig = [
  'CONFIG_WD_BLE_DEVICE_NAME="BNB-WarDriver"',
  'CONFIG_WD_MASTER_UART_PORT_NUM=1',
  'CONFIG_WD_MASTER_UART_TX_GPIO=17',
  'CONFIG_WD_MASTER_UART_RX_GPIO=16',
  'CONFIG_WD_MASTER_UART_BAUD=921600',
  'CONFIG_WD_MASTER_ESPNOW_CHANNEL=1',
  '# CONFIG_WD_TRANSPORT_UART is not set',
  'CONFIG_WD_TRANSPORT_ESPNOW=y',
  'CONFIG_WD_ESPNOW_CHANNEL=1',
].join('\n')

test('master profile writes only its configured master values', () => {
  const request = flashRequestSchema.parse({
    profile: 'master',
    serialPort: '/dev/ttyUSB0',
    settings: {
      bleDeviceName: 'Bench-Unit',
      uartPort: 2,
      txGpio: 21,
      rxGpio: 22,
      baudRate: 460800,
      espnowChannel: 6,
    },
  })
  const output = renderSdkconfig(existingConfig, request)

  assert.match(output, /^CONFIG_WD_BLE_DEVICE_NAME="Bench-Unit"$/m)
  assert.match(output, /^CONFIG_WD_MASTER_UART_PORT_NUM=2$/m)
  assert.match(output, /^CONFIG_WD_MASTER_UART_TX_GPIO=21$/m)
  assert.match(output, /^CONFIG_WD_MASTER_UART_RX_GPIO=22$/m)
  assert.match(output, /^CONFIG_WD_MASTER_UART_BAUD=460800$/m)
  assert.match(output, /^CONFIG_WD_MASTER_ESPNOW_CHANNEL=6$/m)
  assert.equal((output.match(/^CONFIG_WD_MASTER_UART_TX_GPIO=/gm) ?? []).length, 1)
})

test('wired scanner profile selects UART and applies its UART settings', () => {
  const request = flashRequestSchema.parse({
    profile: 'scanner-uart',
    serialPort: '/dev/ttyACM0',
    settings: { uartPort: 1, txGpio: 8, rxGpio: 9, baudRate: 921600 },
  })
  const output = renderSdkconfig(existingConfig, request)

  assert.match(output, /^CONFIG_WD_TRANSPORT_UART=y$/m)
  assert.match(output, /^# CONFIG_WD_TRANSPORT_ESPNOW is not set$/m)
  assert.match(output, /^CONFIG_WD_UART_TX_GPIO=8$/m)
  assert.match(output, /^CONFIG_WD_UART_RX_GPIO=9$/m)
  assert.match(output, /^CONFIG_WD_UART_BAUD=921600$/m)
})

test('wireless scanner profile selects ESP-NOW and applies its channel', () => {
  const request = flashRequestSchema.parse({
    profile: 'scanner-espnow',
    serialPort: '/dev/ttyUSB1',
    settings: { espnowChannel: 11 },
  })
  const output = renderSdkconfig(existingConfig, request)

  assert.match(output, /^# CONFIG_WD_TRANSPORT_UART is not set$/m)
  assert.match(output, /^CONFIG_WD_TRANSPORT_ESPNOW=y$/m)
  assert.match(output, /^CONFIG_WD_ESPNOW_CHANNEL=11$/m)
})

test('request validation rejects duplicate UART pins and invalid channels', () => {
  const duplicatePins = flashRequestSchema.safeParse({
    profile: 'scanner-uart',
    serialPort: '/dev/ttyUSB0',
    settings: { uartPort: 1, txGpio: 8, rxGpio: 8, baudRate: 921600 },
  })
  const invalidChannel = flashRequestSchema.safeParse({
    profile: 'scanner-espnow',
    serialPort: '/dev/ttyUSB0',
    settings: { espnowChannel: 14 },
  })

  assert.equal(duplicatePins.success, false)
  assert.equal(invalidChannel.success, false)
})

test('terminal progress output is readable in the browser console', () => {
  const output = cleanTerminalOutput(
    '\u001B[1A\u001B[2KWriting at 0x0001c887 \u001B[38;2;249;38;114m━━━━╸━━━━━━━━\u001B[0m 2.1% 16.00kB/767.13kB [0s]\u001B[1A',
  )

  assert.equal(output, 'Writing at 0x0001c887  2.1% 16.00kB/767.13kB [0s]')
})