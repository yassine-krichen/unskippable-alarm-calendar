import type { CapacitorConfig } from '@capacitor/cli';

// Android shell (spec section 10). The web bundle for the phone is built into dist-android, never
// into dist: dist is the Electron app's input. The native project lives at the repo root.
const config: CapacitorConfig = {
  appId: 'com.yassine.alarmcalendar',
  appName: 'Alarm Calendar',
  webDir: 'dist-android',
  android: {
    path: '../android',
  },
};

export default config;
