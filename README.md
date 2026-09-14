# homebridge-matter-power

Matter-only Homebridge plugin that exposes arbitrary MQTT electrical measurements as native Matter data for Apple Home (iOS/iPadOS/tvOS 27+).

> Early development / proof of concept. Not published to npm yet.

## What it does

The plugin creates virtual Matter `OnOffOutlet` accessories and feeds them from numeric MQTT topics.

Supported measurements:

- active power (`ElectricalPowerMeasurement.activePower`)
- voltage (`ElectricalPowerMeasurement.voltage`)
- active current (`ElectricalPowerMeasurement.activeCurrent`)
- cumulative imported/consumed energy (`ElectricalEnergyMeasurement.cumulativeEnergyImported`)
- cumulative exported/returned energy (`ElectricalEnergyMeasurement.cumulativeEnergyExported`)
- experimental battery state of charge (`PowerSource.batPercentRemaining`)

Matter uses milli-units internally for the electrical measurements. Battery SoC is converted from 0-100% to Matter's 0-200 `batPercentRemaining` scale.

Example:

```text
Node-RED / MQTT
  home/house/power         1842 W
  home/house/voltage       231.4 V
  home/house/current       7.9 A
  home/house/energy_total  9482.63 kWh
             |
             v
   homebridge-matter-power
             |
             v
      Matter OnOffOutlet
      ElectricalPowerMeasurement
      ElectricalEnergyMeasurement
             |
             v
       Apple Home / iOS 27
```

The endpoint intentionally uses Matter's `OnOffOutlet` device type. Current Apple Home versions show live wattage on outlet-typed Matter accessories, while identical power clusters on some other device types are not shown directly on the tile.

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

Power-only configuration remains supported:

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

A device with power, voltage, current and cumulative consumed energy:

```json
{
  "id": "house",
  "name": "Hausverbrauch",
  "topic": "home/house/power",
  "voltageTopic": "home/house/voltage",
  "currentTopic": "home/house/current",
  "energyImportedTopic": "home/house/energy_total",
  "energyImportedUnit": "kWh"
}
```

A bidirectional grid meter can expose both cumulative directions:

```json
{
  "id": "grid",
  "name": "Netz",
  "topic": "home/grid/power",
  "voltageTopic": "home/grid/voltage",
  "currentTopic": "home/grid/current",
  "energyImportedTopic": "home/grid/import_total",
  "energyImportedUnit": "kWh",
  "energyExportedTopic": "home/grid/export_total",
  "energyExportedUnit": "kWh"
}
```

A battery can additionally expose SoC:

```json
{
  "id": "byd",
  "name": "BYD Speicher",
  "topic": "home/battery/power",
  "batterySocTopic": "home/battery/soc"
}
```

The SoC topic must publish a numeric value from `0` to `100`. Example:

```text
home/battery/soc -> 73.5
```

which becomes Matter `batPercentRemaining = 147`.

Optional MQTT authentication:

```json
{
  "mqttUsername": "user",
  "mqttPassword": "password"
}
```

All topics must contain plain numeric payloads.

### Units and multipliers

Power topics are interpreted as watts by default. If the source publishes kW, use:

```json
{
  "topic": "home/pv/power_kw",
  "multiplier": 1000
}
```

Voltage and current are interpreted as V and A. Optional `voltageMultiplier` and `currentMultiplier` fields can scale unusual source units.

Energy topics support `Wh` and `kWh`:

```json
{
  "energyImportedTopic": "home/house/energy_total",
  "energyImportedUnit": "kWh"
}
```

Use a **monotonically increasing cumulative energy counter**. Do not feed a daily counter that resets to zero into `cumulativeEnergyImported` or `cumulativeEnergyExported`.

Using an explicit `id` is recommended because it keeps the Matter accessory identity stable when MQTT topics are changed later.

## Battery SoC notes

Battery SoC support is experimental. Homebridge 2.4 exposes the standard Matter `PowerSource` cluster and automatically composes the required battery/rechargeable Matter features when a battery attribute is present.

Only devices with `batterySocTopic` get a `PowerSource` cluster. Existing non-battery accessories therefore keep their current Matter identity. Adding or removing `batterySocTopic` intentionally changes the accessory identity once so controllers discover the battery capability from a fresh endpoint.

Apple Home support for `batPercentRemaining` on bridged Matter accessories is currently limited. The initial value may be visible while later percentage updates can lag or remain stale because of controller/reporting behavior. The plugin still sends every changed SoC value to Homebridge/Matter and logs the first successfully published value.

## Node-RED

Publish numeric values to the configured MQTT topics. Retained MQTT messages are recommended so Homebridge receives the most recent values immediately after reconnecting.

Example:

```text
home/house/power         -> 1842
home/house/voltage       -> 231.4
home/house/current       -> 7.9
home/house/energy_total  -> 9482.63
home/battery/power       -> -2480
home/battery/soc         -> 73.5
```

## v0.2 schema migration

v0.2 adds the energy cluster and voltage/current attributes to every virtual accessory so the Matter endpoint shape remains stable when optional topics are added later.

To avoid Apple/Homebridge retaining the older v0.1 endpoint shape, v0.2 uses a new internal accessory identity. Existing v0.1 virtual outlets will therefore be removed and recreated once when upgrading. The Matter child bridge itself remains the same; normally it does not need to be paired again.

## v0.3 battery support

v0.3 adds optional `batterySocTopic` support through Matter `PowerSource.batPercentRemaining`. Non-battery accessories keep the v0.2/v0.2.1 identity. Battery-enabled accessories use a separate battery schema identity so Apple/Homebridge discovers the additional PowerSource capability on a newly created endpoint.

## Current scope

Implemented:

- multiple virtual electrical devices
- MQTT input
- MQTT username/password
- active power in W
- voltage in V
- active current in A
- cumulative imported energy in Wh/kWh
- cumulative exported energy in Wh/kWh
- experimental battery SoC in percent
- optional per-measurement multipliers
- native Matter `ElectricalPowerMeasurement`
- native Matter `ElectricalEnergyMeasurement`
- native Matter `PowerSource` for battery-enabled accessories
- outlet device type for Apple Home live-watt display
- Homebridge Matter accessory cache handling

Not implemented yet:

- periodic energy intervals / historical interval data
- native Matter Solar Power / Battery Storage device types
- battery charge/discharge state
- JSON payload extraction
- npm publishing

## Development

```bash
npm install
npm run build
```

## License

MIT
