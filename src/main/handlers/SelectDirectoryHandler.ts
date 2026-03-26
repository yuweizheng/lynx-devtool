// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import BaseHandler from '@/main/base/BaseHandler';
import { dialog } from 'electron';

class SelectDirectoryHandler extends BaseHandler {
  getName(): string {
    return 'select-directory';
  }
  async handle(_: any): Promise<any> {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Source Code Directory'
    });
    if (result.canceled || !result.filePaths.length) {
      return { canceled: true };
    }
    return { canceled: false, path: result.filePaths[0] };
  }
}

export default SelectDirectoryHandler;
