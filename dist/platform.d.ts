import type { API, DynamicPlatformPlugin, Logging, MatterAccessory, PlatformConfig } from 'homebridge';
export declare class MatterPowerPlatform implements DynamicPlatformPlugin {
    private readonly log;
    private readonly api;
    private readonly matter;
    private readonly cachedMatterAccessories;
    private readonly bindingsByTopic;
    private readonly lastMatterValues;
    private readonly firstLoggedValues;
    private mqttClient?;
    constructor(log: Logging, platformConfig: PlatformConfig, api: API);
    /** This plugin publishes no HAP accessories. */
    configureAccessory(): void;
    /** Restore Matter accessories from Homebridge's cache on restart. */
    configureMatterAccessory(accessory: MatterAccessory): void;
    private parseDevices;
    private buildAccessory;
    private addBinding;
    private start;
    private connectMqtt;
    private toSafeInteger;
    private publishBinding;
    private handleMqttMessage;
    private stop;
}
