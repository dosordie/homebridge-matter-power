# homebridge-matter-power

Matter-only Homebridge plugin that exposes arbitrary MQTT power values as native Matter electrical power measurements for Apple Home (iOS/iPadOS/tvOS 27+).

> Early development / proof of concept. Not published to npm yet.

## What it does

A numeric MQTT payload is interpreted as a power value and exposed through Matter's native `ElectricalPowerMeasurement.activePower` attribute.

Example:

```text
Node-RED -> MQTT topic home/pv/power -> 6432 W
                                      |
                                      v
                           homebridge-matter-power
                                      |
                                      v
                         Matter OnOffOutlet endpoint
                         activePower = 6,432,000 mW
                                      |
                                      v
                              Apple Home / iOS 27
```

The endpoint intentionally uses Matter's `OnOffOutlet` device type for the first Apple Home test. Current Apple Home versions show live wattage on outlet-typed Matter accessories, while identical power clusters on some other device types are not shown directly on the tile.

## Requirements

- Homebridge 2.4.0+
- Node.js 22.12+, 24 or 26
- Homebridge child bridge with **Matter enabled**
- MQTT broker
- iOS/iPadOS/tvOS 27+ for Apple's new power display

This plugin is Matter-only and publishes no HAP accessories. Pair the **Matter QR code**, not the HAP QR code.

## Install for testing

Until the plugin is published to npm, install the branch as a GitHub source archive instead of a `git+https` dependency. Some npm/Homebridge installations create a broken global symlink while preparing a direct Git dependency.

```bash
sudo rm -rf /usr/lib/node_modules/homebridge-matter-power
sudo rm -rf /usr/lib/node_modules/.homebridge-matter-power-*
sudo npm install -g "https://github.com/dosordie/homebridge-matter-power/archive/refs/heads/feature/initial-mqtt-matter-power.tar.gz"
```

The repository contains prebuilt `dist/*.js` files, so no local TypeScript compiler is required for this test installation.

## Configuration

```json
{
  "name": "Matter Power",
  "platform": "MatterPower",
  "mqttUrl": "mqtt://192.168.10.10:1883",
  "devices": [
    {
      "id": "pv",
      "name": "PV-Anlage",
      "topic": "home/pv/power"
    }
  ]
}
```

Optional MQTT authentication:

```json
{
  "mqttUsername": "user",
  "mqttPassword": "password"
}
```

Each topic must currently contain a plain numeric payload. Example:

```text
6432
```

means `6432 W`.

If the MQTT value is in kW, configure a multiplier of `1000`:

```json
{
  "id": "pv",
  "name": "PV-Anlage",
  "topic": "home/pv/power_kw",
  "multiplier": 1000
}
```

Using an explicit `id` is recommended because it keeps the Matter accessory identity stable if the MQTT topic is changed later. If `id` is omitted, the topic is used as the identity.

## Node-RED test

Publish the current PV power to:

```text
home/pv/power
```

with a numeric payload such as:

```text
6432
```

Using a retained MQTT message is recommended so the last known power value is available immediately after Homebridge reconnects.

## Current scope

Implemented in the first proof of concept:

- multiple virtual power devices
- MQTT input
- MQTT username/password
- optional per-device multiplier
- native Matter `ElectricalPowerMeasurement`
- outlet device type for Apple Home live-watt display
- Homebridge Matter accessory cache handling

Not implemented yet:

- cumulative energy / kWh
- voltage and current
- battery state of charge
- native Matter Solar Power / Battery Storage device types
- JSON payload extraction
- npm publishing

## Development

```bash
npm install
npm run build
```

## License

MIT
