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
type MeasurementKind = 'power' | 'voltage' | 'current' | 'energyImported' | 'energyExported' | 'batterySoc';

interface PowerDeviceConfig {
  id?: string;
  name: string;
  topic: string;
  multiplier?: number;
  voltageTopic?: string;
  voltageMultiplier?: number;
  currentTopic?: string;
  currentMultiplier?: number;
  energyImportedTopic?: string;
  energyImportedUnit?: EnergyUnit;
  energyExportedTopic?: string;
  energyExportedUnit?: EnergyUnit;
  batterySocTopic?: string;
}

interface RuntimePowerDevice {
  uuid: string;
  name: string;
  topic: string;
  multiplier: number;
  voltageTopic?: string;
  voltageMultiplier: number;
  currentTopic?: string;
  currentMultiplier: number;
  energyImportedTopic?: string;
  energyImportedUnit: EnergyUnit;
  energyExportedTopic?: string;
  energyExportedUnit: EnergyUnit;
  batterySocTopic?: string;
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

function optionalTopic(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveMultiplier(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}

function energyUnit(value: unknown): EnergyUnit {
  return value === 'Wh' ? 'Wh' : 'kWh';
}

export class MatterPowerPlatform implements DynamicPlatformPlugin {
  private readonly matter!: MatterAPI;
  private readonly cachedMatterAccessories = new Map<string, MatterAccessory>();
  private readonly bindingsByTopic = new Map<string, TopicBinding[]>();
  private readonly lastMatterValues = new Map<string, number>();
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
      const batterySocTopic = optionalTopic(raw.batterySocTopic);

      if (!name || !topic || !id) {
        this.log.warn('Skipping a device with missing name/topic.');
        continue;
      }

      if (seenIds.has(id)) {
        this.log.error(`Skipping duplicate device id '${id}'. Device ids must be unique.`);
        continue;
      }
      seenIds.add(id);

      const identity = batterySocTopic
        ? `${PLUGIN_NAME}:${ACCESSORY_SCHEMA_VERSION}:battery-${BATTERY_SCHEMA_VERSION}:${id}`
        : `${PLUGIN_NAME}:${ACCESSORY_SCHEMA_VERSION}:${id}`;

      devices.push({
        uuid: this.matter.uuid.generate(identity),
        name,
        topic,
        multiplier: positiveMultiplier(raw.multiplier),
        voltageTopic: optionalTopic(raw.voltageTopic),
        voltageMultiplier: positiveMultiplier(raw.voltageMultiplier),
        currentTopic: optionalTopic(raw.currentTopic),
        currentMultiplier: positiveMultiplier(raw.currentMultiplier),
        energyImportedTopic: optionalTopic(raw.energyImportedTopic),
        energyImportedUnit: energyUnit(raw.energyImportedUnit),
        energyExportedTopic: optionalTopic(raw.energyExportedTopic),
        energyExportedUnit: energyUnit(raw.energyExportedUnit),
        batterySocTopic,
      });
    }

    return devices;
  }

  private buildAccessory(device: RuntimePowerDevice): MatterAccessory {
    return {
      UUID: device.uuid,
      displayName: device.name,
      deviceType: this.matter.deviceTypes.OnOffOutlet,
      manufacturer: 'homebridge-matter-power',
      model: 'Virtual MQTT Power',
      serialNumber: `HMP-${device.uuid.replace(/-/g, '').slice(0, 12).toUpperCase()}`,
      context: {
        schemaVersion: ACCESSORY_SCHEMA_VERSION,
        batterySchemaVersion: device.batterySocTopic ? BATTERY_SCHEMA_VERSION : undefined,
      },
      clusters: {
        onOff: { onOff: true },
        electricalPowerMeasurement: {
          activePower: 0,
          voltage: null,
          activeCurrent: null,
        },
        electricalEnergyMeasurement: {
          cumulativeEnergyImported: { energy: 0 },
          cumulativeEnergyExported: { energy: 0 },
        },
        ...(device.batterySocTopic ? {
          powerSource: {
            batPercentRemaining: 0,
            batPresent: true,
          },
        } : {}),
      },
    };
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

    // Cached Matter accessories are restored by Homebridge automatically. Register only new UUIDs.
    const newAccessories = desiredAccessories
      .filter((accessory) => !this.cachedMatterAccessories.has(accessory.UUID));
    if (newAccessories.length > 0) {
      await this.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, newAccessories);
    }

    const existingAccessories = desiredAccessories
      .filter((accessory) => this.cachedMatterAccessories.has(accessory.UUID));
    if (existingAccessories.length > 0) {
      await this.matter.updatePlatformAccessories(existingAccessories);
    }

    for (const device of devices) {
      this.addBinding(device.topic, device, 'power');
      this.addBinding(device.voltageTopic, device, 'voltage');
      this.addBinding(device.currentTopic, device, 'current');
      this.addBinding(device.energyImportedTopic, device, 'energyImported');
      this.addBinding(device.energyExportedTopic, device, 'energyExported');
      this.addBinding(device.batterySocTopic, device, 'batterySoc');
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

    switch (kind) {
      case 'power': {
        const watts = rawValue * device.multiplier;
        matterValue = this.toSafeInteger(watts * 1000, `power value for '${device.name}'`);
        cluster = this.matter.clusterNames.ElectricalPowerMeasurement;
        state = { activePower: matterValue };
        logValue = `${watts} W`;
        break;
      }
      case 'voltage': {
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
        const amps = rawValue * device.currentMultiplier;
        if (amps < 0) {
          this.log.warn(`Ignoring negative current for '${device.name}': ${amps} A`);
          return;
        }
        matterValue = this.toSafeInteger(amps * 1000, `current value for '${device.name}'`);
        cluster = this.matter.clusterNames.ElectricalPowerMeasurement;
        state = { activeCurrent: matterValue };
        logValue = `${amps} A`;
        break;
      }
      case 'energyImported':
      case 'energyExported': {
        if (rawValue < 0) {
          this.log.warn(`Ignoring negative cumulative energy for '${device.name}': ${rawValue}`);
          return;
        }
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
      case 'batterySoc': {
        if (rawValue < 0 || rawValue > 100) {
          this.log.warn(`Ignoring battery SoC outside 0..100 for '${device.name}': ${rawValue} %`);
          return;
        }
        matterValue = this.toSafeInteger(rawValue * 2, `battery SoC for '${device.name}'`);
        cluster = this.matter.clusterNames.PowerSource;
        state = {
          batPercentRemaining: matterValue,
          batPresent: true,
        };
        logValue = `${rawValue} %`;
        break;
      }
    }

    if (matterValue === undefined) return;

    const cacheKey = `${device.uuid}:${kind}`;
    if (this.lastMatterValues.get(cacheKey) === matterValue) return;

    try {
      await this.matter.updateAccessoryState(device.uuid, cluster, state);
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
