import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import '@fontsource/inter/500-italic.css';
import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { DayDeckSystem } from './daydeck.js';
import { maybeInstallEmulator } from './emulate.js';

Promise.all([
  maybeInstallEmulator(),
  ...['500 20px Inter', '600 20px Inter', '700 20px Inter', '800 20px Inter', 'italic 500 20px Inter'].map((f) =>
    document.fonts.load(f).catch(() => undefined),
  ),
])
  .then(() =>
    World.create(
      document.getElementById('scene-container') as HTMLDivElement,
      projectOptions,
    ),
  )
  .then((world) => {
    world.registerSystem(DayDeckSystem);
    (window as any).__world = world;
  });
