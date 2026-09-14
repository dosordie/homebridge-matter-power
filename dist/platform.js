import { connect } from 'mqtt';
import { MIN_HOMEBRIDGE_VERSION, PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

const DEFAULT_MQTT_URL = 'mqtt://127.0.0.1:1883';

export class MatterPowerPlatform {
  constructor(log, platformConfig, api) {
    this.log = log;
    this.api = api;
    this.cachedMatterAccessories = new Map();
    this.devicesByTopic = new Map();
    this.lastMilliWatts = new Map();
    const config = platformConfig;

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

  configureAccessory() {}

  configureMatterAccessory(accessory) {
    this.cachedMatterAccessories.set(accessory.UUID, accessory);
  }

  parseDevices(config) {
    const rawDevices = Array.isArray(config.devices) ? config.devices : [];
    const devices = [];
    const seenIds = new Set();

    for (const raw of rawDevices) {
      const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
      const topic = typeof raw?.topic === 'string' ? raw.topic.trim() : '';
      const id = typeof raw?.id === 'string' && raw.id.trim() ? raw.id.trim() : topic;
      const multiplier = typeof raw?.multiplier === 'number' && Number.isFinite(raw.multiplier)
        ? raw.multiplier
        : 1;

      if (!name || !topic || !id) {
        this.log.warn('Skipping a device with missing name/topic.');
        continue;
      }

      if (seenIds.has(id)) {
        this.log.error(`Skipping duplicate device id '${id}'. Device ids must be unique.`);
        continue;
      }
      seenIds.add(id);

      devices.push({
        uuid: this.matter.uuid.generate(`${PLUGIN_NAME}:${id}`),
        name,
        topic,
        multiplier,
      });
    }

    return devices;
  }

  buildAccessory(device) {
    return {
      UUID: device.uuid,
      displayName: device.name,
      deviceType: this.matter.deviceTypes.OnOffOutlet,
      manufacturer: 'homebridge-matter-power',
      model: 'Virtual MQTT Power',
      serialNumber: `HMP-${device.uuid.replace(/-/g, '').slice(0, 12).toUpperCase()}`,
      context: {},
      clusters: {
        onOff: { onOff: true },
        electricalPowerMeasurement: { activePower: 0 },
      },
    };
  }

  async start(config) {
    const devices = this.parseDevices(config);
    if (devices.length === 0) {
      this.log.warn('No power devices are configured. Add at least one MQTT topic in the plugin settings.');
      return;
    }

    const desiredAccessories = devices.map((device) => this.buildAccessory(device));
    const desiredUuids = new Set(desiredAccessories.map((accessory) => accessory.UUID));

    const staleAccessories = [...this.cachedMatterAccessories.values()]
      .filter((accessory) => !desiredUuids.has(accessory.UUID));
    if (staleAccessories.length > 0) {
      await this.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
      for (const accessory of staleAccessories) {
        this.cachedMatterAccessories.delete(accessory.UUID);
      }
    }

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
      const list = this.devicesByTopic.get(device.topic) ?? [];
      list.push(device);
      this.devicesByTopic.set(device.topic, list);
    }

    this.connectMqtt(config);
  }

  connectMqtt(config) {
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
      const topics = [...this.devicesByTopic.keys()];
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

  async handleMqttMessage(topic, payload) {
    const devices = this.devicesByTopic.get(topic);
    if (!devices || devices.length === 0) {
      return;
    }

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

    for (const device of devices) {
      const watts = rawValue * device.multiplier;
      const milliWatts = Math.round(watts * 1000);

      if (!Number.isSafeInteger(milliWatts)) {
        this.log.warn(`Ignoring out-of-range power value for '${device.name}': ${watts} W`);
        continue;
      }

      if (this.lastMilliWatts.get(device.uuid) === milliWatts) {
        continue;
      }

      try {
        await this.matter.updateAccessoryState(
          device.uuid,
          this.matter.clusterNames.ElectricalPowerMeasurement,
          { activePower: milliWatts },
        );
        this.lastMilliWatts.set(device.uuid, milliWatts);
        this.log.debug(`${device.name}: ${watts} W`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error(`Failed to update '${device.name}' Matter power state: ${message}`);
      }
    }
  }

  stop() {
    if (this.mqttClient) {
      this.mqttClient.end(true);
      this.mqttClient = undefined;
    }
  }
}
