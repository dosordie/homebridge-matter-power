import { MatterPowerPlatform } from './platform.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export default (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, MatterPowerPlatform);
};
