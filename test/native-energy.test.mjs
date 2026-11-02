import test from 'node:test';
import assert from 'node:assert/strict';
import { MatterPowerPlatform } from '../dist/platform.js';

function platform() {
  const calls = [];
  const messages = [];
  const api = {
    serverVersion: '2.5.0',
    versionGreaterOrEqual: version => version <= '2.5.0',
    isMatterAvailable: () => true,
    isMatterEnabled: () => true,
    on: () => {},
    matter: {
      uuid: { generate: value => value },
      deviceTypes: Object.fromEntries(
        ['OnOffOutlet', 'ElectricalSensor', 'ElectricalMeter', 'SolarPower',
          'BatteryStorage', 'PowerSource', 'DeviceEnergyManagement'].map(x => [x, x]),
      ),
      clusterNames: {
        ElectricalPowerMeasurement: 'electricalPowerMeasurement',
        ElectricalEnergyMeasurement: 'electricalEnergyMeasurement',
        PowerSource: 'powerSource',
      },
      updateAccessoryState: async (...args) => { calls.push(args); },
    },
  };
  const log = {
    info: (...args) => messages.push(['info', ...args]),
    warn: (...args) => messages.push(['warn', ...args]),
    error: (...args) => messages.push(['error', ...args]),
    debug: (...args) => messages.push(['debug', ...args]),
  };
  return { instance: new MatterPowerPlatform(log, {}, api), calls, messages, api };
}

test('legacy outlet UUID and endpoint shape stay unchanged', () => {
  const { instance } = platform();
  const [d] = instance.parseDevices({ devices: [{ id: 'house', name: 'Hausverbrauch', topic: 'test/w' }] });
  assert.equal(d.uuid, 'homebridge-matter-power:v3:house');
  const a = instance.buildAccessory(d);
  assert.equal(a.deviceType, 'OnOffOutlet');
  assert.ok(a.clusters.onOff);
  assert.ok(a.clusters.electricalEnergyMeasurement.cumulativeEnergyImported);
  assert.ok(a.clusters.electricalEnergyMeasurement.cumulativeEnergyExported);
  assert.equal(a.parts, undefined);
});

test('legacy battery outlet UUID remains stable', () => {
  const { instance } = platform();
  const [d] = instance.parseDevices({ devices: [{
    id: 'byd', name: 'BYD', topic: 'test/w', batterySocTopic: 'test/soc',
  }] });
  assert.equal(d.uuid, 'homebridge-matter-power:v3:battery-v1:byd');
  assert.ok(instance.buildAccessory(d).clusters.powerSource);
});

test('electricalMeter advertises only configured energy direction', () => {
  const { instance } = platform();
  const [d] = instance.parseDevices({ devices: [{
    id: 'grid', name: 'Grid', topic: 'grid/power',
    deviceType: 'electricalMeter', energyExportedTopic: 'grid/export',
  }] });
  const a = instance.buildAccessory(d);
  assert.equal(a.deviceType, 'ElectricalMeter');
  assert.ok(a.clusters.electricalEnergyMeasurement.cumulativeEnergyExported);
  assert.equal('cumulativeEnergyImported' in a.clusters.electricalEnergyMeasurement, false);
  assert.notEqual(d.uuid, 'homebridge-matter-power:v3:grid');
});

test('electrical meter never routes an accidentally configured battery SoC topic', () => {
  const { instance, messages } = platform();
  const [d] = instance.parseDevices({ devices: [{
    id: 'meter', name: 'Meter', topic: 'grid/power', deviceType: 'electricalMeter',
    energyImportedTopic: 'grid/import', batterySocTopic: 'battery/soc',
  }] });
  assert.equal(d.batterySocTopic, undefined);
  assert.equal(instance.buildAccessory(d).clusters.powerSource, undefined);
  assert.ok(messages.some(m => m[0] === 'warn' && m[1].includes('Ignoring batterySocTopic')));
});

test('solar power ignores stray battery SoC without losing generation topic', () => {
  const { instance } = platform();
  const [d] = instance.parseDevices({ devices: [{
    id: 'pv', name: 'PV', topic: 'pv/power', deviceType: 'solarPower',
    energyExportedTopic: 'pv/total', batterySocTopic: 'battery/soc',
  }] });
  assert.equal(d.batterySocTopic, undefined);
  assert.ok(instance.buildAccessory(d).parts.find(p => p.id === 'meter'));
});

test('solar power creates required parts, exports generation as negative power', async () => {
  const { instance, calls } = platform();
  const [d] = instance.parseDevices({ devices: [{
    id: 'pv', name: 'Solar', topic: 'pv/power',
    deviceType: 'solarPower', energyExportedTopic: 'pv/total',
  }] });
  const a = instance.buildAccessory(d);
  assert.equal(a.deviceType, 'SolarPower');
  assert.deepEqual(a.parts.map(x => x.id), ['inverter', 'meter']);
  assert.equal(a.parts[1].clusters.electricalEnergyMeasurement.cumulativeEnergyExported.energy, 0);
  await instance.publishBinding({ device: d, kind: 'power' }, 3500);
  assert.deepEqual(calls[0], [d.uuid, 'electricalPowerMeasurement', { activePower: -3500000 }, 'meter']);
  await instance.publishBinding({ device: d, kind: 'energyExported' }, 500);
  assert.deepEqual(calls[1], [d.uuid, 'electricalEnergyMeasurement',
    { cumulativeEnergyExported: { energy: 500000000 } }, 'meter']);
});

test('battery storage routes SoC, AC and DC power and disables adjustment commands', async () => {
  const { instance, calls } = platform();
  const [d] = instance.parseDevices({ devices: [{
    id: 'byd', name: 'BYD', topic: 'byd/ac', deviceType: 'batteryStorage',
    batterySocTopic: 'byd/soc', batteryDcPowerTopic: 'byd/dc', batteryCapacityMah: 25000,
  }] });
  const a = instance.buildAccessory(d);
  assert.equal(a.deviceType, 'BatteryStorage');
  assert.deepEqual(a.parts.map(x => x.id), ['battery', 'grid', 'ac-meter', 'dc-meter', 'energy-management']);
  const dem = a.parts.find(x => x.id === 'energy-management');
  assert.equal(dem.deviceType, 'DeviceEnergyManagement');
  assert.equal(dem.clusters.deviceEnergyManagement.esaType, 5);
  assert.equal(dem.clusters.deviceEnergyManagement.absMinPower, 0);
  assert.equal(dem.clusters.deviceEnergyManagement.absMaxPower, 0);
  assert.equal(dem.clusters.deviceEnergyManagement.powerAdjustmentCapability, null);
  assert.equal(dem.clusters.deviceEnergyManagement.optOutState, 3);
  await assert.rejects(
    () => dem.handlers.deviceEnergyManagement.powerAdjustRequest({power: 1000, duration: 60}),
    /monitor-only/,
  );
  await assert.rejects(
    () => dem.handlers.deviceEnergyManagement.cancelPowerAdjustRequest(),
    /monitor-only/,
  );
  assert.equal(a.parts[3].clusters.electricalPowerMeasurement.activePower, null);
  await instance.publishBinding({device:d,kind:'batterySoc'},73.5);
  await instance.publishBinding({device:d,kind:'power'},-2500);
  await instance.publishBinding({device:d,kind:'batteryDcPower'},-2300);
  assert.equal(calls[0][3], 'battery');
  assert.equal(calls[0][2].batPercentRemaining, 147);
  assert.equal(calls[1][3], 'ac-meter');
  assert.equal(calls[1][2].activePower, -2500000);
  assert.equal(calls[2][3], 'dc-meter');
  assert.equal(calls[2][2].activePower, -2300000);
});

test('battery storage can report configured physical power limits without control commands', () => {
  const { instance } = platform();
  const [d] = instance.parseDevices({ devices: [{
    id: 'byd-limits', name: 'Battery', topic: 'battery/power',
    deviceType: 'batteryStorage', batterySocTopic: 'battery/soc',
    batteryCapacityMah: 25000,
    batteryMaxChargePowerW: 3000, batteryMaxDischargePowerW: 4600,
  }] });
  const dem = instance.buildAccessory(d).parts.find(x => x.id === 'energy-management');
  assert.equal(dem.clusters.deviceEnergyManagement.absMinPower, -4600000);
  assert.equal(dem.clusters.deviceEnergyManagement.absMaxPower, 3000000);
  assert.equal(dem.clusters.deviceEnergyManagement.powerAdjustmentCapability, null);
  assert.equal(dem.clusters.deviceEnergyManagement.optOutState, 3);
  assert.equal(typeof dem.handlers.deviceEnergyManagement.powerAdjustRequest, 'function');
});

test('battery adjustment demo is opt-in, uses separate identity and rejects commands', async () => {
  const { instance, messages } = platform();
  const config = { devices: [{
    id: 'demo-by-id', name: 'BYD Demo', topic: 'byd/power',
    deviceType: 'batteryStorage', batterySocTopic: 'byd/soc',
    batteryCapacityMah: 25000,
  }] };
  const [normal] = instance.parseDevices(config);
  const [testDevice] = instance.parseDevices({ devices: [{
    ...config.devices[0], batteryAdjustmentTestMode: true,
  }] });
  assert.equal(normal.batteryAdjustmentTestMode, false);
  assert.equal(testDevice.batteryAdjustmentTestMode, true);
  assert.notEqual(normal.uuid, testDevice.uuid);
  assert.match(testDevice.uuid, /adjustment-test/);
  const real = instance.buildAccessory(normal).parts.find(x => x.id === 'energy-management');
  const demo = instance.buildAccessory(testDevice).parts.find(x => x.id === 'energy-management');
  assert.equal(real.clusters.deviceEnergyManagement.powerAdjustmentCapability, null);
  assert.equal(real.clusters.deviceEnergyManagement.optOutState, 3);
  assert.equal(demo.clusters.deviceEnergyManagement.optOutState, 0);
  assert.deepEqual(demo.clusters.deviceEnergyManagement.powerAdjustmentCapability, {
    powerAdjustCapability: [{
      minPower: -1_000_000, maxPower: 1_000_000, minDuration: 60, maxDuration: 3600,
    }],
    cause: 0,
  });
  assert.equal(demo.clusters.deviceEnergyManagement.absMinPower, -1_000_000);
  assert.equal(demo.clusters.deviceEnergyManagement.absMaxPower, 1_000_000);
  await assert.rejects(
    () => demo.handlers.deviceEnergyManagement.powerAdjustRequest({ power: 500_000, duration: 60 }),
    /monitor-only/,
  );
  await assert.rejects(
    () => demo.handlers.deviceEnergyManagement.cancelPowerAdjustRequest(),
    /monitor-only/,
  );
  assert.ok(messages.some(m => m[0] === 'warn' && m[1].includes('SIMULATION')));
});

test('battery adjustment demo flag on a non-battery type is ignored', () => {
  const { instance } = platform();
  const [meter] = instance.parseDevices({ devices: [{
    id: 'meter', name: 'Meter', topic: 'grid/power', deviceType: 'electricalMeter',
    energyImportedTopic: 'grid/kwh', batteryAdjustmentTestMode: true,
  }] });
  assert.equal(meter.batteryAdjustmentTestMode, false);
});

test('incomplete native configs are skipped instead of misrepresenting measurements', () => {
  const { instance } = platform();
  const devices = instance.parseDevices({ devices: [
    { id:'no-solar', name:'PV', deviceType:'solarPower', topic:'pv/w' },
    { id:'no-battery', name:'BYD', deviceType:'batteryStorage', topic:'byd/w' },
    { id:'no-meter', name:'Grid', deviceType:'electricalMeter', topic:'grid/w' },
    { id:'unknown', name:'X', deviceType:'garbage', topic:'x/w' },
  ] });
  assert.equal(devices.length, 0);
});
