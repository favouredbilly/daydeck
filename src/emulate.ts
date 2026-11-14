// Optional desktop emulation for demos/recording: open the app with ?emulate
// to install Meta's IWER WebXR emulator (Quest 3 with hand tracking).
export async function maybeInstallEmulator(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (!params.has('emulate')) return;
  const { XRDevice, metaQuest3 } = await import('iwer');
  const device = new XRDevice(metaQuest3);
  device.primaryInputMode = 'hand';
  device.stereoEnabled = false;
  device.installRuntime({ forceInstall: true } as any);
  (window as any).__xrDevice = device;
}
