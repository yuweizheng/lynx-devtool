// Copyright 2020 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as i18n from '../../core/i18n/i18n.js';
import * as Root from '../../core/root/root.js';
import * as UI from '../../ui/legacy/legacy.js';

// eslint-disable-next-line rulesdir/es_modules_import
import type * as Animation from './animation.js';

let loadedAnimationModule: (typeof Animation|undefined);

const UIStrings = {
  /**
   * @description Title for the 'Animations' tool in the bottom drawer
   */
  animations: 'Animations',
  /**
   * @description Command for showing the 'Animations' tool in the bottom drawer
   */
  showAnimations: 'Show Animations',
};
const str_ = i18n.i18n.registerUIStrings('panels/animation/animation-meta.ts', UIStrings);
const i18nLazyString = i18n.i18n.getLazilyComputedLocalizedString.bind(undefined, str_);

async function loadAnimationModule(): Promise<typeof Animation> {
  if (!loadedAnimationModule) {
    // Side-effect import resources in module.json
    await Root.Runtime.Runtime.instance().loadModulePromise('panels/animation');
    loadedAnimationModule = await import('./animation.js');
  }
  return loadedAnimationModule;
}

// UI.ViewManager.registerViewExtension({
//   location: UI.ViewManager.ViewLocationValues.DRAWER_VIEW,
//   id: 'animations',
//   title: i18nLazyString(UIStrings.animations),
//   commandPrompt: i18nLazyString(UIStrings.showAnimations),
//   persistence: UI.ViewManager.ViewPersistence.CLOSEABLE,
//   order: 0,
//   async loadView() {
//     const Animation = await loadAnimationModule();
//     return Animation.AnimationTimeline.AnimationTimeline.instance();
//   },
// });
