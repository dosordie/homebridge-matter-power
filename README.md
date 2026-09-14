# homebridge-matter-power

Matter-only Homebridge plugin that exposes arbitrary MQTT power values as native Matter electrical power measurements for Apple Home (iOS/iPadOS/tvOS 27+).

> Early development / proof of concept.

The first goal is deliberately small: subscribe to an MQTT topic carrying a numeric value in watts and expose it as a Matter `OnOffOutlet` with the `ElectricalPowerMeasurement.activePower` attribute. Apple Home currently shows live wattage on outlet-typed Matter accessories.

## Planned first test

- MQTT input, e.g. `home/pv/power` with payload `6432`
- virtual Matter outlet named `PV-Anlage`
- native `ElectricalPowerMeasurement.activePower`
- multiple configured virtual power devices
- Matter-only child bridge (no HAP accessory)

Implementation is being prepared on a feature branch before merging into `main`.
