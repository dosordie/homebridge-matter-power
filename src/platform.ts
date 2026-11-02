import { connect, type MqttClient } from 'mqtt';
import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  MatterAccessory,
  MatterAPI,
  PlatformConfig,
} from 'homebridge';

import { MIN_HOMEBRIDGE_VERSION, PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

type EnergyUnit = 'Wh' | 'kWh';
type PowerDeviceType = 'outlet' | 'electricalSensor' | 'electricalMeter' | 'solarPower' | 'batteryStorage';
type MeasurementKind = 'power' | 'voltage' | 'current'
  | 'reactiveCurrent' | 'apparentCurrent' | 'reactivePower' | 'apparentPower'
  | 'rmsVoltage' | 'rmsCurrent' | 'rmsPower' | 'frequency' | 'powerFactor'
  | 'neutralCurrent' | 'harmonicCurrents' | 'harmonicPhases'
  | 'energyImported' | 'energyExported' | 'energyImportedDaily' | 'energyExportedDaily'
  | 'batterySoc' | 'batteryDcPower';

interface PowerDeviceConfig {
  id?: string;
  name: string;
  topic: string;
  deviceType?: PowerDeviceType;
  multiplier?: number;
  voltageTopic?: string;
  voltageMultiplier?: number;
  currentTopic?: string;
  currentMultiplier?: number;
  reactivePowerTopic?: string;
  reactiveCurrentTopic?: string;
  apparentCurrentTopic?: string;
  apparentPowerTopic?: string;
  rmsVoltageTopic?: string;
  rmsCurrentTopic?: string;
  rmsPowerTopic?: string;
  frequencyTopic?: string;
  powerFactorTopic?: string;
  neutralCurrentTopic?: string;
  harmonicCurrentsTopic?: string;
  harmonicPhasesTopic?: string;
  energyImportedDailyTopic?: string;
  energyImportedDailyUnit?: EnergyUnit;
  energyExportedDailyTopic?: string;
  energyExportedDailyUnit?: EnergyUnit;
  energyImportedTopic?: string;
  energyImportedUnit?: EnergyUnit;
  energyExportedTopic?: string;
  energyExportedUnit?: EnergyUnit;
  batterySocTopic?: string;
  batteryDcPowerTopic?: string;
  batteryCapacityMah?: number;
  batteryMaxChargePowerW?: number;
  batteryMaxDischargePowerW?: number;
  batteryAdjustmentTestMode?: boolean;
}

interface RuntimePowerDevice {
  uuid: string;
  name: string;
  topic: string;
  deviceType: PowerDeviceType;
  multiplier: number;
  voltageTopic?: string;
  voltageMultiplier: number;
  currentTopic?: string;
  currentMultiplier: number;
  reactivePowerTopic?: string;
  reactiveCurrentTopic?: string;
  apparentCurrentTopic?: string;
  apparentPowerTopic?: string;
  rmsVoltageTopic?: string;
  rmsCurrentTopic?: string;
  rmsPowerTopic?: string;
  frequencyTopic?: string;
  powerFactorTopic?: string;
  neutralCurrentTopic?: string;
  harmonicCurrentsTopic?: string;
  harmonicPhasesTopic?: string;
  energyImportedDailyTopic?: string;
  energyImportedDailyUnit?: EnergyUnit;
  energyExportedDailyTopic?: string;
  energyExportedDailyUnit: EnergyUnit;
  energyImportedTopic?: string;
  energyImportedUnit: EnergyUnit;
  energyExportedTopic?: string;
  energyExportedUnit: EnergyUnit;
  batterySocTopic?: string;
  batteryDcPowerTopic?: string;
  batteryCapacityMah?: number;
  batteryMaxChargePowerW?: number;
  batteryMaxDischargePowerW?: number;
  batteryAdjustmentTestMode: boolean;
}

interface TopicBinding {
  device: RuntimePowerDevice;
  kind: MeasurementKind;
}

interface MatterPowerConfig extends PlatformConfig {
  mqttUrl?: string;
  mqttUsername?: string;
  mqttPassword?: string;
  devices?: PowerDeviceConfig[];
}

const DEFAULT_MQTT_URL = 'mqtt://127.0.0.1:1883';
const ACCESSORY_SCHEMA_VERSION = 'v3';
const BATTERY_SCHEMA_VERSION = 'v1';
const NATIVE_SCHEMA_VERSION = 'v1';
const BATTERY_STORAGE_SCHEMA_VERSION = 'v2';
const MATTER_EPOCH_UNIX_SECONDS = 946684800; // 2000-01-01T00:00:00Z
const TEST_ADJUSTMENT_POWER_W = 1000; // Deliberate synthetic rating, never sent to the BYD.

function optionalTopic(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveMultiplier(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}

function energyUnit(value: unknown): EnergyUnit {
  return value === 'Wh' ? 'Wh' : 'kWh';
}

function deviceType(value: unknown): PowerDeviceType | undefined {
  if (value === undefined || value === 'outlet') return 'outlet';
  if (value === 'electricalSensor' || value === 'electricalMeter'
    || value === 'solarPower' || value === 'batteryStorage') return value;
  return undefined;
}

export class MatterPowerPlatform implements DynamicPlatformPlugin {
  private readonly matter!: MatterAPI;
  private readonly cachedMatterAccessories = new Map<string, MatterAccessory>();
  private readonly bindingsByTopic = new Map<string, TopicBinding[]>();
  private readonly lastMatterValues = new Map<string, number>();
  private readonly lastDailyPeriodStart = new Map<string, number>();
  private readonly firstLoggedValues = new Set<string>();
  private mqttClient?: MqttClient;

  constructor(
    private readonly log: Logging,
    platformConfig: PlatformConfig,
    private readonly api: API,
  ) {
    const config = platformConfig as MatterPowerConfig;

    if (!api.versionGreaterOrEqual?.(MIN_HOMEBRIDGE_VERSION)) {
      log.error(
        `homebridge-matter-power requires Homebridge ${MIN_HOMEBRIDGE_VERSION} or newer; `
        + `this bridge is running ${api.serverVersion}.`,
      );
      return;
    }

    if (!api.isMatterAvailable?.() || !api.isMatterEnabled?.() || !api.matter) {
      log.error(
        'Matter is not enabled for this bridge. This is a Matter-only plugin. '
        + 'Enable Matter in the plugin child-bridge settings and pair the Matter QR code with Apple Home.',
      );
      return;
    }

    this.matter = api.matter;

    api.on('didFinishLaunching', () => {
      void this.start(config);
    });

    api.on('shutdown', () => {
      this.stop();
    });
  }

  /** This plugin publishes no HAP accessories. */
  configureAccessory(): void {}

  /** Restore Matter accessories from Homebridge's cache on restart. */
  configureMatterAccessory(accessory: MatterAccessory): void {
    this.cachedMatterAccessories.set(accessory.UUID, accessory);
  }

  private parseDevices(config: MatterPowerConfig): RuntimePowerDevice[] {
    const rawDevices = Array.isArray(config.devices) ? config.devices : [];
    const devices: RuntimePowerDevice[] = [];
    const seenIds = new Set<string>();

    for (const raw of rawDevices) {
      const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
      const topic = typeof raw?.topic === 'string' ? raw.topic.trim() : '';
      const id = typeof raw?.id === 'string' && raw.id.trim() ? raw.id.trim() : topic;
      const configuredBatterySocTopic = optionalTopic(raw.batterySocTopic);
      const selectedType = deviceType(raw.deviceType);
      if (!selectedType) {
        this.log.warn(`Skipping '${name}': unsupported deviceType '${String(raw.deviceType)}'.`);
        continue;
      }
      // Only outlets and actual BatteryStorage expose the battery PowerSource cluster.
      // An ElectricalMeter/ElectricalSensor/SolarPower must never receive battery SoC updates.
      const supportsBatterySoc = selectedType === 'outlet' || selectedType === 'batteryStorage';
      const batterySocTopic = supportsBatterySoc ? configuredBatterySocTopic : undefined;
      if (configuredBatterySocTopic && !supportsBatterySoc) {
        this.log.warn(
          `Ignoring batterySocTopic for '${name}': ${selectedType} has no battery PowerSource. `
          + 'Use deviceType "batteryStorage" for a real battery or "outlet" for legacy battery status.',
        );
      }
      if (selectedType !== 'outlet' && !this.api.versionGreaterOrEqual?.('2.5.0')) {
        this.log.error(`Skipping '${name}': deviceType '${selectedType}' requires Homebridge 2.5.0+.`);
        continue;
      }
      if (selectedType === 'solarPower' && !optionalTopic(raw.energyExportedTopic)) {
        this.log.error(`Skipping '${name}': solarPower requires energyExportedTopic (total generation).`);
        continue;
      }
      if (selectedType === 'batteryStorage' && !batterySocTopic) {
        this.log.error(`Skipping '${name}': batteryStorage requires batterySocTopic.`);
        continue;
      }
      if (selectedType === 'batteryStorage'
        && !(typeof raw.batteryCapacityMah === 'number' && Number.isSafeInteger(raw.batteryCapacityMah)
          && raw.batteryCapacityMah > 0)) {
        this.log.error(`Skipping '${name}': batteryStorage requires batteryCapacityMah (rated battery capacity in mAh).`);
        continue;
      }
      if (selectedType === 'batteryStorage'
        && (raw.batteryMaxChargePowerW === undefined || raw.batteryMaxDischargePowerW === undefined)) {
        this.log.warn(
          `'${name}' batteryStorage has no declared maximum charge/discharge power. `
          + 'DeviceEnergyManagement will report 0 W bounds (test-only). '
          + 'Set batteryMaxChargePowerW and batteryMaxDischargePowerW to physical limits.',
        );
      }
      if (selectedType === 'electricalMeter'
        && !optionalTopic(raw.energyImportedTopic) && !optionalTopic(raw.energyExportedTopic)) {
        this.log.error(`Skipping '${name}': electricalMeter requires an imported or exported cumulative energy topic.`);
        continue;
      }

      if (!name || !topic || !id) {
        this.log.warn('Skipping a device with missing name/topic.');
        continue;
      }

      if (seenIds.has(id)) {
        this.log.error(`Skipping duplicate device id '${id}'. Device ids must be unique.`);
        continue;
      }
      seenIds.add(id);

      // Keep existing identities unless a new feature-gated cluster composition is requested.
      // Periodic energy changes the Matter cluster feature set. Use a new
      // identity when enabled so cached endpoints cannot retain old features.
      // SolarPower supports exported yield; generic ElectricalSensor supports both.
      const advancedPowerFeatures = selectedType === 'electricalSensor'
        ? [
            optionalTopic(raw.neutralCurrentTopic) ? 'poly' : '',
            optionalTopic(raw.harmonicCurrentsTopic) ? 'harm' : '',
            optionalTopic(raw.harmonicPhasesTopic) ? 'qual' : '',
          ].filter(Boolean).join('-')
        : '';
      const dailyImported = selectedType === 'electricalSensor'
        ? optionalTopic(raw.energyImportedDailyTopic) : undefined;
      const dailyExported = selectedType === 'solarPower' || selectedType === 'electricalSensor'
        ? optionalTopic(raw.energyExportedDailyTopic) : undefined;
      if (optionalTopic(raw.energyImportedDailyTopic) && selectedType !== 'electricalSensor') {
        this.log.warn(`Ignoring energyImportedDailyTopic for '${name}': only electricalSensor supports daily imported energy.`);
      }
      if (optionalTopic(raw.energyExportedDailyTopic) && !dailyExported) {
        this.log.warn(`Ignoring energyExportedDailyTopic for '${name}': only solarPower/electricalSensor support daily exported energy.`);
      }
      // Keep every v0.3 outlet UUID unchanged, including existing battery-enabled outlets.
      // Switching the opt-in DEM simulation requires a fresh Matter endpoint:
      // Homebridge caches compositions and does not replace them in place.
      const batteryAdjustmentTestMode = selectedType === 'batteryStorage' && raw.batteryAdjustmentTestMode === true;
      if (batteryAdjustmentTestMode) {
        this.log.warn(`'${name}': Battery power adjustment SIMULATION enabled. `
          + 'Advertising test-only ±1000 W, rejecting commands, sending NO MQTT writes.');
      }
      const identity = selectedType === 'batteryStorage'
        ? `${PLUGIN_NAME}:native-${BATTERY_STORAGE_SCHEMA_VERSION}${batteryAdjustmentTestMode ? '-adjustment-test' : ''}:batteryStorage:${id}`
        : selectedType !== 'outlet'
          ? `${PLUGIN_NAME}:native-${NATIVE_SCHEMA_VERSION}${dailyImported || dailyExported ? '-daily-v1' : ''}${advancedPowerFeatures ? '-equality-v1-' + advancedPowerFeatures : ''}:${selectedType}:${id}`
          : batterySocTopic
          ? `${PLUGIN_NAME}:${ACCESSORY_SCHEMA_VERSION}:battery-${BATTERY_SCHEMA_VERSION}:${id}`
          : `${PLUGIN_NAME}:${ACCESSORY_SCHEMA_VERSION}:${id}`;

      devices.push({
        uuid: this.matter.uuid.generate(identity),
        name,
        topic,
        deviceType: selectedType,
        multiplier: positiveMultiplier(raw.multiplier),
        voltageTopic: optionalTopic(raw.voltageTopic),
        voltageMultiplier: positiveMultiplier(raw.voltageMultiplier),
        currentTopic: optionalTopic(raw.currentTopic),
        currentMultiplier: positiveMultiplier(raw.currentMultiplier),
        reactivePowerTopic: optionalTopic(raw.reactivePowerTopic),
        reactiveCurrentTopic: optionalTopic(raw.reactiveCurrentTopic),
        apparentCurrentTopic: optionalTopic(raw.apparentCurrentTopic),
        apparentPowerTopic: optionalTopic(raw.apparentPowerTopic),
        rmsVoltageTopic: optionalTopic(raw.rmsVoltageTopic),
        rmsCurrentTopic: optionalTopic(raw.rmsCurrentTopic),
        rmsPowerTopic: optionalTopic(raw.rmsPowerTopic),
        frequencyTopic: optionalTopic(raw.frequencyTopic),
        powerFactorTopic: optionalTopic(raw.powerFactorTopic),
        neutralCurrentTopic: selectedType === 'electricalSensor' ? optionalTopic(raw.neutralCurrentTopic) : undefined,
        harmonicCurrentsTopic: selectedType === 'electricalSensor' ? optionalTopic(raw.harmonicCurrentsTopic) : undefined,
        harmonicPhasesTopic: selectedType === 'electricalSensor' ? optionalTopic(raw.harmonicPhasesTopic) : undefined,
        energyImportedDailyTopic: dailyImported,
        energyImportedDailyUnit: energyUnit(raw.energyImportedDailyUnit),
        energyExportedDailyTopic: dailyExported,
        energyExportedDailyUnit: energyUnit(raw.energyExportedDailyUnit),
        energyImportedTopic: optionalTopic(raw.energyImportedTopic),
        energyImportedUnit: energyUnit(raw.energyImportedUnit),
        energyExportedTopic: optionalTopic(raw.energyExportedTopic),
        energyExportedUnit: energyUnit(raw.energyExportedUnit),
        batterySocTopic,
        batteryDcPowerTopic: optionalTopic(raw.batteryDcPowerTopic),
        batteryCapacityMah: raw.batteryCapacityMah,
        batteryMaxChargePowerW: this.nonNegativePower(raw.batteryMaxChargePowerW),
        batteryMaxDischargePowerW: this.nonNegativePower(raw.batteryMaxDischargePowerW),
        batteryAdjustmentTestMode,
      });
    }

    return devices;
  }

  private nonNegativePower(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      && Number.isSafeInteger(Math.round(value * 1000)) ? value : undefined;
  }

  private buildAccessory(device: RuntimePowerDevice): MatterAccessory {
    const types = this.matter.deviceTypes;
    const base = {
      UUID: device.uuid,
      displayName: device.name,
      manufacturer: 'homebridge-matter-power',
      model: `Virtual MQTT ${device.deviceType}`,
      serialNumber: `HMP-${device.uuid.replace(/-/g, '').slice(0, 12).toUpperCase()}`,
      context: {
        schemaVersion: ACCESSORY_SCHEMA_VERSION,
        batterySchemaVersion: device.batterySocTopic ? BATTERY_SCHEMA_VERSION : undefined,
        deviceType: device.deviceType,
      },
    };
    const electricalPowerMeasurement = {
      activePower: 0,
      voltage: null,
      activeCurrent: null,
      // AC reactive-power reporting is optional; do not invent a measurement.
      ...(device.reactivePowerTopic ? { reactivePower: null } : {}),
    };
    const nativeEnergy = {
      ...(device.energyImportedTopic ? { cumulativeEnergyImported: { energy: 0 } } : {}),
      ...(device.energyExportedTopic ? { cumulativeEnergyExported: { energy: 0 } } : {}),
      ...(device.energyImportedDailyTopic ? { periodicEnergyImported: null } : {}),
      ...(device.energyExportedDailyTopic ? { periodicEnergyExported: null } : {}),
    };
    // Only configured MQTT measurements appear as optional Matter attributes.
    // Homebridge supplies the required power mode, accuracy and topology.
    const expandedElectricalPowerMeasurement = {
      ...electricalPowerMeasurement,
      ...(device.reactivePowerTopic ? { reactivePower: null } : {}),
      ...(device.reactiveCurrentTopic ? { reactiveCurrent: null } : {}),
      ...(device.apparentCurrentTopic ? { apparentCurrent: null } : {}),
      ...(device.apparentPowerTopic ? { apparentPower: null } : {}),
      ...(device.rmsVoltageTopic ? { rmsVoltage: null } : {}),
      ...(device.rmsCurrentTopic ? { rmsCurrent: null } : {}),
      ...(device.rmsPowerTopic ? { rmsPower: null } : {}),
      ...(device.frequencyTopic ? { frequency: null } : {}),
      ...(device.powerFactorTopic ? { powerFactor: null } : {}),
      ...(device.neutralCurrentTopic ? { neutralCurrent: null } : {}),
      ...(device.harmonicCurrentsTopic ? { harmonicCurrents: null } : {}),
      ...(device.harmonicPhasesTopic ? { harmonicPhases: null } : {}),
    };
    const electricalEnergyMeasurement = device.deviceType === 'outlet'
      ? { cumulativeEnergyImported: { energy: 0 }, cumulativeEnergyExported: { energy: 0 } }
      : nativeEnergy;

    switch (device.deviceType) {
      case 'electricalMeter':
      case 'electricalSensor': {
        const optionalFeatures = device.deviceType === 'electricalSensor'
          ? [
              ...(device.neutralCurrentTopic ? ['PolyphasePower'] : []),
              ...(device.harmonicCurrentsTopic ? ['Harmonics'] : []),
              ...(device.harmonicPhasesTopic ? ['PowerQuality'] : []),
            ]
          : [];
        const sensorType = optionalFeatures.length > 0
          ? (types.ElectricalSensor as any).with(
              (this.matter.deviceRequirements.ElectricalSensor.ElectricalPowerMeasurementServer as any)
                .with('AlternatingCurrent', ...optionalFeatures),
            )
          : types.ElectricalSensor;
        return {
          ...base,
          deviceType: device.deviceType === 'electricalMeter'
            ? types.ElectricalMeter : sensorType,
          clusters: {
            electricalPowerMeasurement: expandedElectricalPowerMeasurement,
            ...(device.deviceType === 'electricalMeter' || Object.keys(nativeEnergy).length > 0
              ? { electricalEnergyMeasurement } : {}),
          },
        };
      }
      case 'solarPower':
        return {
          ...base,
          deviceType: types.SolarPower,
          parts: [
            {
              id: 'inverter',
              displayName: `${device.name} inverter`,
              deviceType: types.PowerSource,
              clusters: { powerSource: {
                status: 1, order: 0, description: 'Solar inverter', wiredCurrentType: 0,
              } },
            },
            {
              id: 'meter',
              displayName: `${device.name} generation`,
              deviceType: types.ElectricalSensor,
              clusters: {
                electricalPowerMeasurement: {
                  activePower: 0, voltage: null, activeCurrent: null,
                  ...(device.reactivePowerTopic ? { reactivePower: null } : {}),
                },
                electricalEnergyMeasurement: {
                  cumulativeEnergyExported: { energy: 0 },
                  ...(device.energyExportedDailyTopic ? { periodicEnergyExported: null } : {}),
                },
              },
            },
          ],
        };
      case 'batteryStorage':
        return {
          ...base,
          deviceType: types.BatteryStorage,
          parts: [
            {
              id: 'battery',
              displayName: `${device.name} battery`,
              deviceType: types.PowerSource,
              clusters: { powerSource: {
                status: 1, order: 0, description: 'Battery',
                batPresent: true, batPercentRemaining: 0,
                batChargeLevel: 0, batReplacementNeeded: false,
                batReplaceability: 3, batChargeState: 0,
                batFunctionalWhileCharging: true,
                batVoltage: null, batCapacity: device.batteryCapacityMah,
                batTimeRemaining: null, batTimeToFullCharge: null,
                batChargingCurrent: null, activeBatFaults: [], activeBatChargeFaults: [],
              } },
            },
            {
              id: 'grid',
              displayName: `${device.name} AC connection`,
              deviceType: types.PowerSource,
              clusters: { powerSource: {
                status: 1, order: 1, description: 'AC connection', wiredCurrentType: 0,
              } },
            },
            {
              id: 'ac-meter',
              displayName: `${device.name} AC measurement`,
              deviceType: types.ElectricalSensor,
              clusters: {
                electricalPowerMeasurement,
                electricalEnergyMeasurement: Object.keys(nativeEnergy).length > 0
                  ? nativeEnergy
                  : { cumulativeEnergyImported: null, cumulativeEnergyExported: null },
              },
            },
            {
              id: 'dc-meter',
              displayName: `${device.name} DC measurement`,
              deviceType: types.ElectricalSensor,
              clusters: {
                electricalPowerMeasurement: {
                  powerMode: 1, activePower: null, voltage: null, activeCurrent: null,
                },
                electricalEnergyMeasurement: {
                  cumulativeEnergyImported: null, cumulativeEnergyExported: null,
                },
              },
            },
            {
              // Matter BatteryStorage requires a DEM component with PowerAdjustment.
              // Advertising a null capability means adjustment is unavailable;
              // reject *all* commands instead of acknowledging fake state changes.
              id: 'energy-management',
              displayName: `${device.name} energy management`,
              deviceType: types.DeviceEnergyManagement,
              clusters: {
                deviceEnergyManagement: {
                  esaType: 5, // BatteryStorage
                  esaCanGenerate: true,
                  esaState: 1, // Online; does not imply charge/discharge control.
                  // Matter requires non-null bounds. 0 is only a test fallback;
                  // configure physical maxima for meaningful rated bounds.
                  absMinPower: device.batteryAdjustmentTestMode
                    ? -TEST_ADJUSTMENT_POWER_W * 1000
                    : device.batteryMaxDischargePowerW
                      ? -Math.round(device.batteryMaxDischargePowerW * 1000) : 0,
                  absMaxPower: device.batteryAdjustmentTestMode
                    ? TEST_ADJUSTMENT_POWER_W * 1000
                    : Math.round((device.batteryMaxChargePowerW ?? 0) * 1000),
                  // Demo mode is an intentional, isolated protocol/UI experiment.
                  // A non-null capability may make controller UI controls visible,
                  // but it NEVER authorizes the plugin to control any physical battery.
                  powerAdjustmentCapability: device.batteryAdjustmentTestMode
                    ? { powerAdjustCapability: [{
                        minPower: -TEST_ADJUSTMENT_POWER_W * 1000,
                        maxPower: TEST_ADJUSTMENT_POWER_W * 1000,
                        minDuration: 60,
                        maxDuration: 3600,
                      }], cause: 0 }
                    : null,
                  optOutState: device.batteryAdjustmentTestMode ? 0 : 3,
                },
              },
              handlers: {
                deviceEnergyManagement: {
                  powerAdjustRequest: async () => {
                    this.log.warn(`'${device.name}': Matter power adjustment request REJECTED; simulation never controls BYD.`);
                    throw new Error('BYD battery is monitor-only: remote power adjustment is disabled.');
                  },
                  cancelPowerAdjustRequest: async () => {
                    throw new Error('BYD battery is monitor-only: no power adjustment can be cancelled.');
                  },
                },
              },
            },
          ],
        };
      default:
        // Preserve the v0.3 OnOffOutlet endpoint structure exactly.
        return {
          ...base,
          deviceType: types.OnOffOutlet,
          clusters: {
            onOff: { onOff: true },
            electricalPowerMeasurement,
            electricalEnergyMeasurement,
            ...(device.batterySocTopic ? { powerSource: {
              batPercentRemaining: 0,
              batPresent: true,
            } } : {}),
          },
        };
    }
  }

  private addBinding(topic: string | undefined, device: RuntimePowerDevice, kind: MeasurementKind): void {
    if (!topic) return;
    const list = this.bindingsByTopic.get(topic) ?? [];
    list.push({ device, kind });
    this.bindingsByTopic.set(topic, list);
  }

  private async start(config: MatterPowerConfig): Promise<void> {
    const devices = this.parseDevices(config);
    if (devices.length === 0) {
      this.log.warn('No power devices are configured. Add at least one MQTT power topic in the plugin settings.');
      return;
    }

    const desiredAccessories = devices.map((device) => this.buildAccessory(device));
    const desiredUuids = new Set(desiredAccessories.map((accessory) => accessory.UUID));

    // Remove cached accessories which no longer exist in the configuration or use an older schema identity.
    const staleAccessories = [...this.cachedMatterAccessories.values()]
      .filter((accessory) => !desiredUuids.has(accessory.UUID));
    if (staleAccessories.length > 0) {
      await this.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
      for (const accessory of staleAccessories) {
        this.cachedMatterAccessories.delete(accessory.UUID);
      }
    }

    // Homebridge 2.5 requires *all* accessories to re-register, even cached ones.
    // It reuses their endpoints and restores handlers/features without replacing their identity.
    await this.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, desiredAccessories);

    for (const device of devices) {
      this.addBinding(device.topic, device, 'power');
      this.addBinding(device.voltageTopic, device, 'voltage');
      this.addBinding(device.currentTopic, device, 'current');
      this.addBinding(device.reactivePowerTopic, device, 'reactivePower');
      this.addBinding(device.reactiveCurrentTopic, device, 'reactiveCurrent');
      this.addBinding(device.apparentCurrentTopic, device, 'apparentCurrent');
      this.addBinding(device.apparentPowerTopic, device, 'apparentPower');
      this.addBinding(device.rmsVoltageTopic, device, 'rmsVoltage');
      this.addBinding(device.rmsCurrentTopic, device, 'rmsCurrent');
      this.addBinding(device.rmsPowerTopic, device, 'rmsPower');
      this.addBinding(device.frequencyTopic, device, 'frequency');
      this.addBinding(device.powerFactorTopic, device, 'powerFactor');
      this.addBinding(device.neutralCurrentTopic, device, 'neutralCurrent');
      this.addBinding(device.harmonicCurrentsTopic, device, 'harmonicCurrents');
      this.addBinding(device.harmonicPhasesTopic, device, 'harmonicPhases');
      this.addBinding(device.energyImportedDailyTopic, device, 'energyImportedDaily');
      this.addBinding(device.energyExportedDailyTopic, device, 'energyExportedDaily');
      this.addBinding(device.energyImportedTopic, device, 'energyImported');
      this.addBinding(device.energyExportedTopic, device, 'energyExported');
      this.addBinding(device.batterySocTopic, device, 'batterySoc');
      if (device.deviceType === 'batteryStorage') {
        this.addBinding(device.batteryDcPowerTopic, device, 'batteryDcPower');
      }
    }

    this.connectMqtt(config);
  }

  private connectMqtt(config: MatterPowerConfig): void {
    const mqttUrl = typeof config.mqttUrl === 'string' && config.mqttUrl.trim()
      ? config.mqttUrl.trim()
      : DEFAULT_MQTT_URL;

    this.log.info(`Connecting to MQTT broker ${mqttUrl}`);

    this.mqttClient = connect(mqttUrl, {
      username: typeof config.mqttUsername === 'string' && config.mqttUsername.length > 0
        ? config.mqttUsername
        : undefined,
      password: typeof config.mqttPassword === 'string' && config.mqttPassword.length > 0
        ? config.mqttPassword
        : undefined,
      reconnectPeriod: 5000,
    });

    this.mqttClient.on('connect', () => {
      const topics = [...this.bindingsByTopic.keys()];
      this.log.info(`MQTT connected; subscribing to ${topics.length} topic(s).`);
      this.mqttClient?.subscribe(topics, { qos: 0 }, (error) => {
        if (error) {
          this.log.error(`MQTT subscribe failed: ${error.message}`);
        }
      });
    });

    this.mqttClient.on('reconnect', () => this.log.debug('MQTT reconnecting...'));
    this.mqttClient.on('offline', () => this.log.warn('MQTT connection is offline.'));
    this.mqttClient.on('error', (error) => this.log.error(`MQTT error: ${error.message}`));
    this.mqttClient.on('message', (topic, payload) => {
      void this.handleMqttMessage(topic, payload.toString('utf8'));
    });
  }

  private toSafeInteger(value: number, label: string): number | undefined {
    const rounded = Math.round(value);
    if (!Number.isSafeInteger(rounded)) {
      this.log.warn(`Ignoring out-of-range ${label}: ${value}`);
      return undefined;
    }
    return rounded;
  }

  private async publishBinding(binding: TopicBinding, rawValue: number): Promise<void> {
    const { device, kind } = binding;
    let cluster: string;
    let state: Record<string, unknown>;
    let matterValue: number | undefined;
    let logValue: string;
    let partId: string | undefined;

    switch (kind) {
      case 'power': {
        // Matter reports outgoing PV generation as negative power.
        const watts = device.deviceType === 'solarPower'
          ? -Math.abs(rawValue * device.multiplier)
          : rawValue * device.multiplier;
        partId = device.deviceType === 'solarPower' ? 'meter'
          : device.deviceType === 'batteryStorage' ? 'ac-meter' : undefined;
        matterValue = this.toSafeInteger(watts * 1000, `power value for '${device.name}'`);
        cluster = this.matter.clusterNames.ElectricalPowerMeasurement;
        state = { activePower: matterValue };
        logValue = `${watts} W`;
        break;
      }
      case 'voltage': {
        partId = device.deviceType === 'solarPower' ? 'meter'
          : device.deviceType === 'batteryStorage' ? 'ac-meter' : undefined;
        const volts = rawValue * device.voltageMultiplier;
        if (volts < 0) {
          this.log.warn(`Ignoring negative voltage for '${device.name}': ${volts} V`);
          return;
        }
        matterValue = this.toSafeInteger(volts * 1000, `voltage value for '${device.name}'`);
        cluster = this.matter.clusterNames.ElectricalPowerMeasurement;
        state = { voltage: matterValue };
        logValue = `${volts} V`;
        break;
      }
      case 'current': {
        partId = device.deviceType === 'solarPower' ? 'meter'
          : device.deviceType === 'batteryStorage' ? 'ac-meter' : undefined;
        // In Matter, current leaving a generator is negative, just like active power.
        // Other device types retain the signed input; negative grid flow is valid.
        const inputAmps = rawValue * device.currentMultiplier;
        const amps = device.deviceType === 'solarPower' ? -Math.abs(inputAmps) : inputAmps;
        matterValue = this.toSafeInteger(amps * 1000, `current value for '${device.name}'`);
        cluster = this.matter.clusterNames.ElectricalPowerMeasurement;
        state = { activeCurrent: matterValue };
        logValue = `${amps} A`;
        break;
      }
      case 'reactivePower': {
        // AC reactive power in var -> mvar. Preserve physical flow sign.
        const vars = rawValue;
        matterValue = this.toSafeInteger(vars * 1000, `reactive power for '${device.name}'`);
        partId = device.deviceType === 'solarPower' ? 'meter'
          : device.deviceType === 'batteryStorage' ? 'ac-meter' : undefined;
        cluster = this.matter.clusterNames.ElectricalPowerMeasurement;
        state = { reactivePower: matterValue };
        logValue = `${vars} var`;
        break;
      }
      case 'neutralCurrent':
      case 'reactiveCurrent':
      case 'apparentCurrent':
      case 'apparentPower':
      case 'rmsVoltage':
      case 'rmsCurrent':
      case 'rmsPower':
      case 'frequency':
      case 'powerFactor': {
        // Matter electric measurement units:
        // currents in mA, powers in mW/mVA, voltages in mV,
        // frequency in mHz, power factor in 0.01 % (1.0 => 10000).
        const scale = kind === 'powerFactor' ? 10000 : 1000;
        if (kind === 'powerFactor' && (rawValue < -1 || rawValue > 1)) {
          this.log.warn(`Ignoring powerFactor outside -1..1 for '${device.name}': ${rawValue}`);
          return;
        }
        if ((kind === 'rmsVoltage' || kind === 'frequency') && rawValue < 0) {
          this.log.warn(`Ignoring negative ${kind} for '${device.name}': ${rawValue}`);
          return;
        }
        matterValue = this.toSafeInteger(rawValue * scale, `${kind} for '${device.name}'`);
        cluster = this.matter.clusterNames.ElectricalPowerMeasurement;
        partId = device.deviceType === 'solarPower' ? 'meter'
          : device.deviceType === 'batteryStorage' ? 'ac-meter' : undefined;
        state = { [kind]: matterValue };
        logValue = `${rawValue} ${kind === 'powerFactor' ? 'PF' : kind === 'frequency' ? 'Hz'
          : kind.includes('Current') ? 'A' : kind === 'rmsVoltage' ? 'V' : 'VA/W'}`;
        break;
      }
      case 'harmonicCurrents':
      case 'harmonicPhases':
        // Harmonics are encoded as a JSON array and handled separately.
        return;
      case 'energyImported':
      case 'energyExported': {
        if (rawValue < 0) {
          this.log.warn(`Ignoring negative cumulative energy for '${device.name}': ${rawValue}`);
          return;
        }
        partId = device.deviceType === 'solarPower' ? 'meter'
          : device.deviceType === 'batteryStorage' ? 'ac-meter' : undefined;
        const unit = kind === 'energyImported' ? device.energyImportedUnit : device.energyExportedUnit;
        const milliWh = rawValue * (unit === 'kWh' ? 1_000_000 : 1000);
        matterValue = this.toSafeInteger(milliWh, `energy value for '${device.name}'`);
        cluster = this.matter.clusterNames.ElectricalEnergyMeasurement;
        state = kind === 'energyImported'
          ? { cumulativeEnergyImported: { energy: matterValue } }
          : { cumulativeEnergyExported: { energy: matterValue } };
        logValue = `${rawValue} ${unit}`;
        break;
      }
      case 'energyImportedDaily':
      case 'energyExportedDaily': {
        // Daily production/consumption is PERIODIC, not a lifetime counter.
        // The local day is determined by the Homebridge host's timezone.
        if (device.deviceType !== 'solarPower' && device.deviceType !== 'electricalSensor') return;
        const imported = kind === 'energyImportedDaily';
        if (imported && device.deviceType === 'solarPower') return;
        if (rawValue < 0) {
          this.log.warn(`Ignoring negative ${kind} for '${device.name}': ${rawValue}`);
          return;
        }
        const unit = imported ? device.energyImportedDailyUnit : device.energyExportedDailyUnit;
        const milliWh = rawValue * (unit === 'kWh' ? 1_000_000 : 1000);
        matterValue = this.toSafeInteger(milliWh, `${kind} for '${device.name}'`);
        const now = new Date();
        const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startTimestamp = Math.floor(midnight.getTime() / 1000) - MATTER_EPOCH_UNIX_SECONDS;
        const endTimestamp = Math.floor(now.getTime() / 1000) - MATTER_EPOCH_UNIX_SECONDS;
        cluster = this.matter.clusterNames.ElectricalEnergyMeasurement;
        partId = device.deviceType === 'solarPower' ? 'meter' : undefined;
        const attribute = imported ? 'periodicEnergyImported' : 'periodicEnergyExported';
        state = { [attribute]: { energy: matterValue, startTimestamp, endTimestamp } };
        logValue = `${rawValue} ${unit} since local midnight`;
        break;
      }
      case 'batterySoc': {
        if (rawValue < 0 || rawValue > 100) {
          this.log.warn(`Ignoring battery SoC outside 0..100 for '${device.name}': ${rawValue} %`);
          return;
        }
        matterValue = this.toSafeInteger(rawValue * 2, `battery SoC for '${device.name}'`);
        cluster = this.matter.clusterNames.PowerSource;
        partId = device.deviceType === 'batteryStorage' ? 'battery' : undefined;
        state = {
          batPercentRemaining: matterValue,
          batPresent: true,
        };
        logValue = `${rawValue} %`;
        break;
      }
      case 'batteryDcPower': {
        matterValue = this.toSafeInteger(rawValue * 1000, `DC power for '${device.name}'`);
        cluster = this.matter.clusterNames.ElectricalPowerMeasurement;
        state = { activePower: matterValue };
        partId = 'dc-meter';
        logValue = `${rawValue} W (DC)`;
        break;
      }
    }

    if (matterValue === undefined) return;

    // For daily counters, a reset at midnight can legitimately repeat the same
    // numeric reading as yesterday; the period start is part of its identity.
    const cacheKey = `${device.uuid}:${kind}`;
    if (kind === 'energyExportedDaily' || kind === 'energyImportedDaily') {
      const periodic = state.periodicEnergyExported ?? state.periodicEnergyImported;
      const periodStart = (periodic as { startTimestamp: number }).startTimestamp;
      const previousPeriod = this.lastDailyPeriodStart.get(cacheKey);
      if (previousPeriod !== periodStart) {
        this.lastMatterValues.delete(cacheKey);
      }
      this.lastDailyPeriodStart.set(cacheKey, periodStart);
    }
    if (this.lastMatterValues.get(cacheKey) === matterValue) return;

    try {
      await this.matter.updateAccessoryState(device.uuid, cluster, state, partId);
      this.lastMatterValues.set(cacheKey, matterValue);
      if (!this.firstLoggedValues.has(cacheKey)) {
        this.firstLoggedValues.add(cacheKey);
        this.log.info(`${device.name} ${kind}: ${logValue}`);
      } else {
        this.log.debug(`${device.name} ${kind}: ${logValue}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`Failed to update '${device.name}' ${kind} Matter state: ${message}`);
    }
  }

  private async handleMqttMessage(topic: string, payload: string): Promise<void> {
    const bindings = this.bindingsByTopic.get(topic);
    if (!bindings || bindings.length === 0) return;

    const text = payload.trim();
    if (!text) {
      this.log.warn(`Ignoring empty MQTT payload on '${topic}'.`);
      return;
    }

    const rawValue = Number(text);
    if (!Number.isFinite(rawValue)) {
      this.log.warn(`Ignoring non-numeric MQTT payload on '${topic}': ${JSON.stringify(text)}`);
      return;
    }

    for (const binding of bindings) {
      await this.publishBinding(binding, rawValue);
    }
  }

  private stop(): void {
    if (this.mqttClient) {
      this.mqttClient.end(true);
      this.mqttClient = undefined;
    }
  }
}
