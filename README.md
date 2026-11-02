# homebridge-matter-power

Matter-only Homebridge plugin that exposes arbitrary MQTT electrical measurements as native Matter data for Apple Home (iOS/iPadOS/tvOS 27+).

> Early development / proof of concept. Not published to npm yet.

## What it does

The plugin creates virtual Matter electrical accessories from numeric MQTT topics. Existing configurations continue to create `OnOffOutlet` accessories; v0.4 adds opt-in native energy device types.

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

- Homebridge 2.4.0+ for legacy outlet mode; **2.5.0+ for new native device types**
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

## v0.4 experimental native energy devices (Homebridge 2.5+)

The default `deviceType: "outlet"` keeps the **exact v0.3 Matter UUID**, including existing outlet battery SoC. Nothing changes unless you explicitly opt in.

Supported values for `deviceType`: `outlet`, `electricalSensor`, `electricalMeter`, `solarPower`, `batteryStorage`. Switching between them intentionally creates a different Matter accessory identity. The Matter child bridge itself is not reset.

### Grid electricity meter

```json
{
  "id": "grid-native-test",
  "name": "Netz Test",
  "deviceType": "electricalMeter",
  "topic": "home/grid/power",
  "energyImportedTopic": "home/grid/import_total",
  "energyImportedUnit": "kWh",
  "energyExportedTopic": "home/grid/export_total",
  "energyExportedUnit": "kWh"
}
```

`electricalMeter` requires at least one cumulative energy topic. Positive watts mean import; negative watts mean export. The native endpoint advertises only configured energy directions (unlike the legacy outlet which retains both for compatibility).

### Solar Power

```json
{
  "id": "solar-native-test",
  "name": "PV Test",
  "deviceType": "solarPower",
  "topic": "home/pv/power",
  "energyExportedTopic": "home/pv/energy_total",
  "energyExportedUnit": "kWh"
}
```

The input topic is positive **generation** in watts. Matter reports outgoing generation as negative active power. Solar production is reported as `cumulativeEnergyExported`, not imported. A composed Matter SolarPower device includes a wired PowerSource and an ElectricalSensor part named `meter`.

#### Extra PV measurements (v0.4.5)

The original `voltageTopic` and `currentTopic` now support signed AC generation properly. Add real inverter **AC-output** measurements (not net grid exchange) to your SolarPower device:

```json
{
  "id": "pv-native-test",
  "name": "PV Leistung",
  "deviceType": "solarPower",
  "topic": "home/pv/ac_power_w",
  "voltageTopic": "home/pv/ac_voltage_v",
  "currentTopic": "home/pv/ac_current_a",
  "reactivePowerTopic": "home/pv/reactive_var",
  "energyExportedTopic": "home/pv/lifetime_kwh",
  "energyExportedUnit": "kWh",
  "energyExportedDailyTopic": "home/pv/today_kwh",
  "energyExportedDailyUnit": "kWh"
}
```

All example topics are placeholders. Voltage is sent in Matter millivolts. Solar current from a positive generation-current magnitude is sent as **negative mA**, consistent with the negative `activePower` of an exporting PV plant. Negative signed current measurements are accepted for all device types; for non-solar devices their sign is preserved. `reactivePowerTopic` reports signed var (converted to mvar); it does not silently invert the sign, because actual reactive-power direction must come from the source.

**PV total vs grid export:** `energyExportedTopic` must be the **monotonically increasing total PV generated**, not the grid export counter. With batteries this distinction is essential: exported grid energy and PV production are not the same. If combining two inverters, sum their actual generated energies without double-counting battery discharge.

**Optional daily PV yield:** `energyExportedDailyTopic` is energy produced *since midnight*, not a cumulative lifetime counter. It is mapped to Matter `periodicEnergyExported` using the Homebridge host's **local timezone** for midnight and the current timestamp for the period end. Make sure the server's timezone and source counter's daily reset agree (including DST), publish a fresh retained reading after midnight, and use `energyExportedDailyUnit` (Wh or kWh). Daily yield is not used to fabricate a lifetime kWh counter.

Enabling the daily feature adds the Matter `PeriodicEnergy` feature. It therefore uses a **new SolarPower device identity** to avoid Homebridge restoring an incompatible cached cluster shape; Apple Home may need time to discover the replacement endpoint. Removing the daily topic restores the original SolarPower identity. The existing native power and cumulative-energy behavior is unchanged when the daily topic is absent.

Neither current, reactive power nor the daily energy attributes are guaranteed to appear in Apple Home: controllers decide which Matter energy attributes to display. The core AC power measurement continues to work even when those topics are omitted.


### Battery Storage

```json
{
  "id": "byd-native-test",
  "name": "BYD Test",
  "deviceType": "batteryStorage",
  "topic": "home/byd/ac_power",
  "batterySocTopic": "home/byd/soc",
  "batteryDcPowerTopic": "home/byd/dc_power",
  "batteryCapacityMah": 25000,
  "batteryMaxChargePowerW": 3000,
  "batteryMaxDischargePowerW": 4600,
  "energyImportedTopic": "home/byd/charged_total",
  "energyExportedTopic": "home/byd/discharged_total"
}
```

Battery power convention: **positive = charging; negative = discharging**. `batteryCapacityMah` is required because Matter mandates a rated battery capacity. The example `25000` means 25 Ah at pack voltage (approximately BYD HVS capacity); it is **not** 25000 kWh. `batteryDcPowerTopic` and energy totals are optional; unknown DC/energy values remain null rather than being fabricated. The composed device includes battery and wired AC PowerSource parts, plus AC and DC ElectricalSensor parts. Matter requires a `DeviceEnergyManagement` part with the `PowerAdjustment` feature, so v0.4.3 adds the endpoint with `powerAdjustmentCapability: null` (adjustments unavailable), `optOutState: 3`, and handlers that reject all adjustment/cancellation requests. The plugin **never controls the inverter or battery**, including in the optional UI simulation. Use `batteryMaxChargePowerW` and `batteryMaxDischargePowerW` for **actual hardware maximum power values** (the example 3000/4600 W is illustrative only, not inferred from your BYD). If omitted, the required power bounds default to 0 W for a temporary test and a warning is logged; those values are not meaningful hardware specifications. The SoC is sent to the `battery` PowerSource part with 0.5% resolution.

#### Optional Matter adjustment UI simulation (v0.4.4)

To test whether a controller displays *additional* controls for native BatteryStorage, add `"batteryAdjustmentTestMode": true` to **that device only**. The plugin then advertises a **synthetic** adjustable range of -1000 to +1000 W (60–3600 seconds), clears the DEM external optimization opt-out, and uses a distinct Matter endpoint identity so Homebridge does not restore stale cached options.

**No physical battery operation occurs.** Every Matter adjustment or cancellation command is explicitly rejected, **no MQTT control messages are published**, and the apparent capabilities are *for controller-UI diagnosis only*. Other apps may show controls that cannot do anything. This mode does not make an unsupported Matter device type supported by Apple Home; do not assume it will fix energy data rendering. Return to `false` or remove the field after testing to restore the existing monitor-only endpoint. The normal mode's declared hardware limits are unaffected.



Do **not** repurpose a live inverter's PV production counter as a battery charge counter. Select the topics corresponding to the actual measurement direction.

### Compatibility and caveats

- `batterySocTopic` is supported only for `outlet` and `batteryStorage`. If configured on `electricalMeter`, `electricalSensor` or `solarPower`, the value is ignored with a startup warning. Native meters have no battery `PowerSource` cluster.

- Homebridge 2.5.0+ is mandatory for the three new native energy device types and `electricalSensor`.
- **Real Apple Home 27.2 results:** native ElectricalMeter appears and displays live wattage, but no kWh; native SolarPower and BatteryStorage registered successfully in Homebridge but were invisible in Apple Home in initial tests. Adding the missing BatteryStorage DeviceEnergyManagement part fixes a Matter conformance warning, not necessarily Apple's lack of UI support.
- Existing `outlet` devices retain their UUID, state shape and watt display. Test new types under **new device IDs**, leaving your current `Hausverbrauch` alone.
- Standalone per-device Matter pairing is **not** exposed as a selectable mode by Homebridge 2.5.0's public `MatterAPI`. `registerPlatformAccessories` bridges these types; only selected internally forced types publish externally. A `standalone` option would falsely promise functionality, so it has not been added.
- Native device type conversion intentionally changes the Matter endpoint identity. Back up Homebridge configuration before testing.

## Current scope

Implemented:

- optional Matter 1.6 device types: ElectricalSensor, ElectricalMeter, SolarPower, BatteryStorage (Homebridge 2.5+)

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
- optional native Matter Solar Power / Battery Storage device types (experimental)
- automatic battery charging state from a separate MQTT status topic (currently unknown without explicit input)
- JSON payload extraction
- per-device standalone Matter publishing (not in Homebridge 2.5 public API)
- npm publishing

## Development

```bash
npm install
npm run build
```

## License

MIT
