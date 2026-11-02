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

test('PV reports signed current, actual AC voltage and reactive power', async () => {
  const { instance, calls } = platform();
  const [pv] = instance.parseDevices({ devices: [{
    id: 'pv', name: 'PV', topic: 'pv/w', deviceType: 'solarPower',
    voltageTopic: 'pv/volts', currentTopic: 'pv/amps', reactivePowerTopic: 'pv/var',
    energyExportedTopic: 'pv/lifetime', voltageMultiplier: 1, currentMultiplier: 1,
  }] });
  const sensor = instance.buildAccessory(pv).parts.find(x => x.id === 'meter');
  assert.equal(sensor.clusters.electricalPowerMeasurement.reactivePower, null);
  await instance.publishBinding({ device: pv, kind: 'voltage' }, 232.4);
  await instance.publishBinding({ device: pv, kind: 'current' }, 8.25);
  await instance.publishBinding({ device: pv, kind: 'reactivePower' }, -45.5);
  await instance.publishBinding({ device: pv, kind: 'current' }, -9);
  assert.deepEqual(calls[0], [pv.uuid, 'electricalPowerMeasurement', { voltage: 232400 }, 'meter']);
  assert.deepEqual(calls[1], [pv.uuid, 'electricalPowerMeasurement', { activeCurrent: -8250 }, 'meter']);
  assert.deepEqual(calls[2], [pv.uuid, 'electricalPowerMeasurement', { reactivePower: -45500 }, 'meter']);
  assert.deepEqual(calls[3], [pv.uuid, 'electricalPowerMeasurement', { activeCurrent: -9000 }, 'meter']);
});

test('signed currents on the grid meter are retained, not discarded', async () => {
  const { instance, calls, messages } = platform();
  const [grid] = instance.parseDevices({ devices: [{
    id: 'grid', name: 'Grid', topic: 'grid/power', deviceType: 'electricalMeter',
    currentTopic: 'grid/current', energyImportedTopic: 'grid/lifetime',
  }] });
  await instance.publishBinding({ device: grid, kind: 'current' }, -7.35);
  assert.deepEqual(calls[0], [grid.uuid, 'electricalPowerMeasurement', { activeCurrent: -7350 }, undefined]);
  assert.equal(messages.some(x => x[0] === 'warn'), false);
});

test('PV daily yield is periodic, local-day timestamped and never changes lifetime counter', async () => {
  const { instance, calls } = platform();
  const base = {
    id: 'solar', name: 'Solar', topic: 'pv/w', deviceType: 'solarPower',
    energyExportedTopic: 'pv/all', energyExportedUnit: 'kWh',
  };
  const [withoutDaily] = instance.parseDevices({ devices: [base] });
  const [withDaily] = instance.parseDevices({ devices: [{
    ...base, energyExportedDailyTopic: 'pv/today', energyExportedDailyUnit: 'Wh',
  }] });
  assert.notEqual(withDaily.uuid, withoutDaily.uuid);
  assert.equal(withoutDaily.energyExportedDailyTopic, undefined);
  assert.equal(instance.buildAccessory(withoutDaily).parts[1].clusters.electricalEnergyMeasurement.periodicEnergyExported, undefined);
  const energyCluster = instance.buildAccessory(withDaily).parts[1].clusters.electricalEnergyMeasurement;
  assert.equal(energyCluster.periodicEnergyExported, null);
  assert.deepEqual(energyCluster.cumulativeEnergyExported, { energy: 0 });
  await instance.publishBinding({ device: withDaily, kind: 'energyExportedDaily' }, 1234);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'electricalEnergyMeasurement');
  assert.equal(calls[0][3], 'meter');
  const first = calls[0][2].periodicEnergyExported;
  assert.equal(first.energy, 1234000);
  const now = new Date((first.endTimestamp + 946684800) * 1000);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  assert.equal(first.startTimestamp, Math.floor(midnight.getTime() / 1000) - 946684800);
  assert.ok(first.endTimestamp >= first.startTimestamp);
  await instance.publishBinding({ device: withDaily, kind: 'energyExportedDaily' }, -5);
  assert.equal(calls.length, 1, 'negative daily values are ignored');
  await instance.publishBinding({ device: withDaily, kind: 'energyExported' }, 3456.5);
  assert.deepEqual(calls[1][2], { cumulativeEnergyExported: { energy: 3456500000 } });
});

test('PV daily yield topic is not routed onto a grid meter', () => {
  const { instance, messages } = platform();
  const [meter] = instance.parseDevices({ devices: [{
    id: 'grid', name: 'Meter', topic: 'grid/w', deviceType: 'electricalMeter',
    energyImportedTopic: 'grid/in', energyExportedDailyTopic: 'grid/today',
  }] });
  assert.equal(meter.energyExportedDailyTopic, undefined);
  assert.ok(messages.some(m => m[0] === 'warn' && m[1].includes('Ignoring energyExportedDailyTopic')));
});

test('ElectricalSensor maps all standard AC scalar meter topics to Matter units', async () => {
  const { instance, calls, messages } = platform();
  const [sensor] = instance.parseDevices({ devices: [{
    id: 'ac-sensor', name: 'AC Sensor', deviceType: 'electricalSensor', topic: 'ac/w',
    voltageTopic: 'ac/v', currentTopic: 'ac/i',
    reactivePowerTopic: 'ac/q', reactiveCurrentTopic: 'ac/iq',
    apparentCurrentTopic: 'ac/is', apparentPowerTopic: 'ac/s',
    rmsVoltageTopic: 'ac/vrms', rmsCurrentTopic: 'ac/irms',
    rmsPowerTopic: 'ac/wrms', frequencyTopic: 'ac/hz',
    powerFactorTopic: 'ac/pf',
    energyImportedTopic: 'ac/in', energyExportedTopic: 'ac/out',
  }] });
  const a = instance.buildAccessory(sensor);
  assert.equal(a.deviceType, 'ElectricalSensor');
  assert.equal(a.clusters.electricalPowerMeasurement.frequency, null);
  assert.equal(a.clusters.electricalPowerMeasurement.apparentPower, null);
  assert.equal(a.clusters.electricalPowerMeasurement.powerFactor, null);
  assert.ok(a.clusters.electricalEnergyMeasurement.cumulativeEnergyImported);
  assert.ok(a.clusters.electricalEnergyMeasurement.cumulativeEnergyExported);
  const values = [
    ['power', -520, 'activePower', -520000],
    ['voltage', 229.8, 'voltage', 229800],
    ['current', -2.5, 'activeCurrent', -2500],
    ['reactivePower', -31, 'reactivePower', -31000],
    ['reactiveCurrent', -0.7, 'reactiveCurrent', -700],
    ['apparentCurrent', 2.6, 'apparentCurrent', 2600],
    ['apparentPower', 610, 'apparentPower', 610000],
    ['rmsVoltage', 231.2, 'rmsVoltage', 231200],
    ['rmsCurrent', -3.2, 'rmsCurrent', -3200],
    ['rmsPower', -510.5, 'rmsPower', -510500],
    ['frequency', 49.97, 'frequency', 49970],
    ['powerFactor', 0.96, 'powerFactor', 9600],
  ];
  for (const [kind, input, field, expected] of values) {
    await instance.publishBinding({ device: sensor, kind }, input);
    assert.deepEqual(calls[calls.length - 1],
      [sensor.uuid, 'electricalPowerMeasurement', { [field]: expected }, undefined]);
  }
  assert.equal(calls.length, values.length);
  await instance.publishBinding({ device: sensor, kind: 'powerFactor' }, 1.2);
  await instance.publishBinding({ device: sensor, kind: 'frequency' }, -1);
  await instance.publishBinding({ device: sensor, kind: 'rmsVoltage' }, -4);
  assert.equal(calls.length, values.length);
  assert.ok(messages.some(m => m[0] === 'warn' && m[1].includes('powerFactor outside')));
});

test('ElectricalSensor reports imported and exported energy for local-day periods', async () => {
  const { instance, calls } = platform();
  const base = {
    id: 'sensor-periods', name: 'Meter', topic: 'm/p', deviceType: 'electricalSensor',
  };
  const [oldDevice] = instance.parseDevices({ devices: [base] });
  const [d] = instance.parseDevices({ devices: [{
    ...base, energyImportedDailyTopic: 'm/in/today', energyImportedDailyUnit: 'Wh',
    energyExportedDailyTopic: 'm/out/today', energyExportedDailyUnit: 'kWh',
  }] });
  assert.notEqual(d.uuid, oldDevice.uuid);
  const attr = instance.buildAccessory(d).clusters.electricalEnergyMeasurement;
  assert.equal(attr.periodicEnergyImported, null);
  assert.equal(attr.periodicEnergyExported, null);
  assert.equal(attr.cumulativeEnergyImported, undefined);
  await instance.publishBinding({device:d,kind:'energyImportedDaily'},1250);
  await instance.publishBinding({device:d,kind:'energyExportedDaily'},3.5);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][2].periodicEnergyImported.energy, 1250000);
  assert.equal(calls[1][2].periodicEnergyExported.energy, 3500000);
  assert.equal(calls[0][2].periodicEnergyImported.startTimestamp,
    calls[1][2].periodicEnergyExported.startTimestamp);
  assert.equal(calls[0][3], undefined);
  assert.equal(calls[1][3], undefined);
});

test('ElectricalSensor composes Matter Polyphase/Harmonics/PowerQuality features', async () => {
  const { instance, calls, api, messages } = platform();
  api.matter.deviceRequirements = {
    ElectricalSensor: {
      ElectricalPowerMeasurementServer: {
        with: (...features) => ({ clusterName: 'electricalPowerMeasurement', features }),
      },
    },
  };
  api.matter.deviceTypes.ElectricalSensor = {
    with: behavior => ({ name: 'ElectricalSensor', behavior }),
  };
  const [d] = instance.parseDevices({ devices: [{
    id: 'advanced', name: 'Advanced', deviceType: 'electricalSensor', topic: 'a/w',
    neutralCurrentTopic: 'a/neutral', harmonicCurrentsTopic: 'a/harmonic-i',
    harmonicPhasesTopic: 'a/harmonic-phase',
  }] });
  const a = instance.buildAccessory(d);
  assert.deepEqual(a.deviceType.behavior.features, [
    'AlternatingCurrent', 'PolyphasePower', 'Harmonics', 'PowerQuality',
  ]);
  assert.equal(a.clusters.electricalPowerMeasurement.neutralCurrent, null);
  assert.equal(a.clusters.electricalPowerMeasurement.harmonicCurrents, null);
  assert.equal(a.clusters.electricalPowerMeasurement.harmonicPhases, null);
  await instance.publishBinding({ device: d, kind: 'neutralCurrent' }, -1.25);
  assert.deepEqual(calls[0][2], { neutralCurrent: -1250 });
  await instance.publishHarmonics({ device: d, kind: 'harmonicCurrents' },
    JSON.stringify([{ order: 3, measurement: 0.012 }, { order: 5, measurement: null }]));
  assert.deepEqual(calls[1][2], {
    harmonicCurrents: [{ order: 3, measurement: 12 }, { order: 5, measurement: null }],
  });
  await instance.publishHarmonics({ device: d, kind: 'harmonicPhases' },
    JSON.stringify([{ order: 3, measurement: -7.5 }]));
  assert.deepEqual(calls[2][2], { harmonicPhases: [{ order: 3, measurement: -7500 }] });
  await instance.publishHarmonics({ device: d, kind: 'harmonicPhases' },
    JSON.stringify([{ order: 3, measurement: 1 }, { order: 3, measurement: 4 }]));
  assert.equal(calls.length, 3, 'duplicate harmonic order must be rejected');
  assert.ok(messages.some(m => m[0] === 'warn' && m[1].includes('malformed harmonicPhases')));
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
