const { contextBridge } = require('electron');

<<<<<<< HEAD
const desktopBridge = {
  platform: process.platform,
  isDesktopApp: true,
};

contextBridge.exposeInMainWorld('jewshiDesktop', desktopBridge);
contextBridge.exposeInMainWorld('sclshiDesktop', desktopBridge);
=======
contextBridge.exposeInMainWorld('jewshiDesktop', {
  platform: process.platform,
  isDesktopApp: true,
});
>>>>>>> 12d69b1 (checking...)
