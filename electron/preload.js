const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('jewshiDesktop', {
  platform: process.platform,
  isDesktopApp: true,
});
