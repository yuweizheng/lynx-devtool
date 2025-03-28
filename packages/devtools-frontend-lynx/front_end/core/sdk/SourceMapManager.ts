// Copyright 2017 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

/* eslint-disable rulesdir/no_underscored_properties */

import * as Common from '../common/common.js';
import * as i18n from '../i18n/i18n.js';
import * as Platform from '../platform/platform.js';

import type {FrameAssociated} from './FrameAssociated.js'; // eslint-disable-line no-unused-vars
import type {Target} from './Target.js';
import {Events as TargetManagerEvents, TargetManager} from './TargetManager.js';  // eslint-disable-line no-unused-vars
import type {SourceMap} from './SourceMap.js';
import {TextSourceMap} from './SourceMap.js';  // eslint-disable-line no-unused-vars
import { DOMModel } from './DOMModel.js';

const UIStrings = {
  /**
  *@description Error message when failing to load a source map text
  *@example {An error occurred} PH1
  */
  devtoolsFailedToLoadSourcemapS: 'DevTools failed to load source map: {PH1}',
};
const str_ = i18n.i18n.registerUIStrings('core/sdk/SourceMapManager.ts', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);

export class SourceMapManager<T extends FrameAssociated> extends Common.ObjectWrapper.ObjectWrapper {
  _target: Target;
  _isEnabled: boolean;
  _relativeSourceURL: Map<T, string>;
  _relativeSourceMapURL: Map<T, string>;
  _resolvedSourceMapId: Map<T, string>;
  _sourceMapById: Map<string, SourceMap>;
  _sourceMapIdToLoadingClients: Platform.MapUtilities.Multimap<string, T>;
  _sourceMapIdToClients: Platform.MapUtilities.Multimap<string, T>;

  constructor(target: Target) {
    super();

    this._target = target;
    this._isEnabled = true;

    this._relativeSourceURL = new Map();
    this._relativeSourceMapURL = new Map();
    this._resolvedSourceMapId = new Map();

    this._sourceMapById = new Map();
    this._sourceMapIdToLoadingClients = new Platform.MapUtilities.Multimap();
    this._sourceMapIdToClients = new Platform.MapUtilities.Multimap();

    TargetManager.instance().addEventListener(TargetManagerEvents.InspectedURLChanged, this._inspectedURLChanged, this);
  }

  setEnabled(isEnabled: boolean): void {
    if (isEnabled === this._isEnabled) {
      return;
    }
    this._isEnabled = isEnabled;
    // We need this copy, because `this._resolvedSourceMapId` is getting modified
    // in the loop body and trying to iterate over it at the same time leads to
    // an infinite loop.
    const clients = [...this._resolvedSourceMapId.keys()];
    for (const client of clients) {
      const relativeSourceURL = this._relativeSourceURL.get(client);
      const relativeSourceMapURL = this._relativeSourceMapURL.get(client);
      this.detachSourceMap(client);
      this.attachSourceMap(client, relativeSourceURL, relativeSourceMapURL);
    }
  }

  _inspectedURLChanged(event: Common.EventTarget.EventTargetEvent): void {
    if (event.data !== this._target) {
      return;
    }

    // We need this copy, because `this._resolvedSourceMapId` is getting modified
    // in the loop body and trying to iterate over it at the same time leads to
    // an infinite loop.
    const prevSourceMapIds = new Map(this._resolvedSourceMapId);
    for (const [client, prevSourceMapId] of prevSourceMapIds) {
      const relativeSourceURL = this._relativeSourceURL.get(client);
      const relativeSourceMapURL = this._relativeSourceMapURL.get(client);
      if (relativeSourceURL === undefined || relativeSourceMapURL === undefined) {
        continue;
      }
      const resolvedUrls = this._resolveRelativeURLs(relativeSourceURL, relativeSourceMapURL);
      if (resolvedUrls !== null && prevSourceMapId !== resolvedUrls.sourceMapId) {
        this.detachSourceMap(client);
        this.attachSourceMap(client, relativeSourceURL, relativeSourceMapURL);
      }
    }
  }

  sourceMapForClient(client: T): SourceMap|null {
    const sourceMapId = this._resolvedSourceMapId.get(client);
    if (!sourceMapId) {
      return null;
    }
    return this._sourceMapById.get(sourceMapId) || null;
  }

  clientsForSourceMap(sourceMap: SourceMap): T[] {
    const sourceMapId = this._getSourceMapId(sourceMap.compiledURL(), sourceMap.url());
    if (this._sourceMapIdToClients.has(sourceMapId)) {
      return [...this._sourceMapIdToClients.get(sourceMapId)];
    }
    return [...this._sourceMapIdToLoadingClients.get(sourceMapId)];
  }

  _getSourceMapId(sourceURL: string, sourceMapURL: string): string {
    return `${sourceURL}:${sourceMapURL}`;
  }

  _resolveRelativeURLs(sourceURL: string, sourceMapURL: string): {
    sourceURL: string,
    sourceMapURL: string,
    sourceMapId: string,
  }|null {
    // if inspectedURL = '', sourceURL must be absolute path (such as 'file://')
    // if inspectedURL = (for example) 'file://Lynx.html', sourceURL can be relative path (such as 'app-service.js')
    const resolvedSourceURL = Common.ParsedURL.ParsedURL.completeURL(this._target.inspectedURL(), sourceURL);
    if (!resolvedSourceURL) {
      return null;
    }
    const resolvedSourceMapURL = Common.ParsedURL.ParsedURL.completeURL(resolvedSourceURL, sourceMapURL);
    if (!resolvedSourceMapURL) {
      return null;
    }
    return {
      sourceURL: resolvedSourceURL,
      sourceMapURL: resolvedSourceMapURL,
      sourceMapId: this._getSourceMapId(resolvedSourceURL, resolvedSourceMapURL),
    };
  }

  attachSourceMap(client: T, relativeSourceURL: string|undefined, relativeSourceMapURL: string|undefined): void {
    // TODO(chromium:1011811): Strengthen the type to obsolte the undefined check once core/sdk/ is fully typescriptified.
    if (relativeSourceURL === undefined || !relativeSourceMapURL) {
      return;
    }
    console.assert(!this._resolvedSourceMapId.has(client), 'SourceMap is already attached to client');
    const resolvedURLs = this._resolveRelativeURLs(relativeSourceURL, relativeSourceMapURL);
    if (!resolvedURLs) {
      return;
    }
    this._relativeSourceURL.set(client, relativeSourceURL);
    this._relativeSourceMapURL.set(client, relativeSourceMapURL);

    const {sourceURL, sourceMapURL, sourceMapId} = resolvedURLs;
    this._resolvedSourceMapId.set(client, sourceMapId);

    if (!this._isEnabled) {
      return;
    }

    this.dispatchEventToListeners(Events.SourceMapWillAttach, client);

    if (this._sourceMapById.has(sourceMapId)) {
      attach.call(this, sourceMapId, client);
      return;
    }
    if (!this._sourceMapIdToLoadingClients.has(sourceMapId)) {
      TextSourceMap.load(sourceMapURL, sourceURL, client.createPageResourceLoadInitiator())
          .catch(error => {
            Common.Console.Console.instance().warn(
                i18nString(UIStrings.devtoolsFailedToLoadSourcemapS, {PH1: error.message}));
            return null;
          })
          .then(onSourceMap.bind(this, sourceMapId));
    }
    this._sourceMapIdToLoadingClients.set(sourceMapId, client);

    function onSourceMap(this: SourceMapManager<T>, sourceMapId: string, sourceMap: SourceMap|null): void {
      this._sourceMapLoadedForTest();
      const clients = this._sourceMapIdToLoadingClients.get(sourceMapId);
      this._sourceMapIdToLoadingClients.deleteAll(sourceMapId);
      if (!clients.size) {
        return;
      }
      if (!sourceMap) {
        for (const client of clients) {
          this.dispatchEventToListeners(Events.SourceMapFailedToAttach, client);
        }
        return;
      }
      this._sourceMapById.set(sourceMapId, sourceMap);
      for (const client of clients) {
        attach.call(this, sourceMapId, client);
      }
    }

    function attach(this: SourceMapManager<T>, sourceMapId: string, client: T): void {
      this._sourceMapIdToClients.set(sourceMapId, client);
      const sourceMap = this._sourceMapById.get(sourceMapId);
      if (sourceMapId.includes("app-service.js")) {
        const domModel = (this._target.model(DOMModel) as DOMModel);
        domModel.setUISourcemap(sourceMap);
      }
      this.dispatchEventToListeners(Events.SourceMapAttached, {client: client, sourceMap: sourceMap});
    }
  }

  detachSourceMap(client: T): void {
    const sourceMapId = this._resolvedSourceMapId.get(client);
    this._relativeSourceURL.delete(client);
    this._relativeSourceMapURL.delete(client);
    this._resolvedSourceMapId.delete(client);

    if (!sourceMapId) {
      return;
    }
    if (!this._sourceMapIdToClients.hasValue(sourceMapId, client)) {
      if (this._sourceMapIdToLoadingClients.delete(sourceMapId, client)) {
        this.dispatchEventToListeners(Events.SourceMapFailedToAttach, client);
      }
      return;
    }
    this._sourceMapIdToClients.delete(sourceMapId, client);
    const sourceMap = this._sourceMapById.get(sourceMapId);
    if (!sourceMap) {
      return;
    }
    if (!this._sourceMapIdToClients.has(sourceMapId)) {
      this._sourceMapById.delete(sourceMapId);
    }
    this.dispatchEventToListeners(Events.SourceMapDetached, {client: client, sourceMap: sourceMap});
  }

  _sourceMapLoadedForTest(): void {
  }

  dispose(): void {
    TargetManager.instance().removeEventListener(
        TargetManagerEvents.InspectedURLChanged, this._inspectedURLChanged, this);
  }
}

export const Events = {
  SourceMapWillAttach: Symbol('SourceMapWillAttach'),
  SourceMapFailedToAttach: Symbol('SourceMapFailedToAttach'),
  SourceMapAttached: Symbol('SourceMapAttached'),
  SourceMapDetached: Symbol('SourceMapDetached'),
};
