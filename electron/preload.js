const { contextBridge } = require('electron');

const desktopBridge = {
  platform: process.platform,
  isDesktopApp: true,
};

contextBridge.exposeInMainWorld('jewshiDesktop', desktopBridge);
contextBridge.exposeInMainWorld('sclshiDesktop', desktopBridge);
