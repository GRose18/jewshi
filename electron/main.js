const path = require('path');
const { app, BrowserWindow, shell } = require('electron');

const isMac = process.platform === 'darwin';
const devUrl = process.env.CLIENT_URL || 'http://localhost:3000';
const packagedUrl = process.env.JEWSHI_DESKTOP_PROD_URL || 'https://jewshi.onrender.com';

function getStartUrl() {
  if (process.env.JEWSHI_DESKTOP_START_URL) return process.env.JEWSHI_DESKTOP_START_URL;
  return app.isPackaged ? packagedUrl : packagedUrl;
}

function createMainWindow() {
  const startUrl = getStartUrl();
  const origin = new URL(startUrl).origin;
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 760,
    title: 'Jewshi',
    backgroundColor: '#0a0a0f',
    show: false,
    autoHideMenuBar: true,
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    try{
      const requestUrl = new URL(details.url);
      if(requestUrl.origin === origin){
        details.requestHeaders['X-Jewshi-Desktop'] = '1';
      }
    }catch(e){}
    callback({ requestHeaders: details.requestHeaders });
  });

  win.webContents.on('will-navigate', (event, url) => {
    const current = new URL(startUrl);
    const next = new URL(url);
    const sameOrigin = current.origin === next.origin;
    if (!sameOrigin) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Jewshi Desktop</title>
        <style>
          body{
            margin:0;
            min-height:100vh;
            display:flex;
            align-items:center;
            justify-content:center;
            background:#0a0a0f;
            color:#eeeef5;
            font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
            padding:32px;
          }
          .card{
            width:min(560px,100%);
            background:#111118;
            border:1px solid rgba(255,255,255,0.08);
            border-radius:24px;
            padding:28px;
            box-shadow:0 24px 60px rgba(0,0,0,0.35);
          }
          h1{margin:0 0 10px;font-size:26px;letter-spacing:-0.03em}
          p{margin:0 0 12px;color:#aaa9bb;line-height:1.6}
          code{
            display:block;
            background:#171722;
            border:1px solid rgba(255,255,255,0.06);
            color:#f0c040;
            border-radius:14px;
            padding:12px 14px;
            margin:12px 0;
            word-break:break-word;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Jewshi couldn’t load</h1>
          <p>The desktop shell started, but it couldn’t reach the app URL.</p>
          <code>${validatedURL || startUrl}</code>
          <p>Error ${errorCode}: ${errorDescription}</p>
          <p>If you wanted the local dev app, run your server first and then use <strong>npm run desktop:local</strong>. Otherwise use <strong>npm run desktop</strong> or <strong>npm run desktop:web</strong> for the hosted app.</p>
        </div>
      </body>
      </html>
    `)}`);
  });

  win.loadURL(startUrl);
}

app.whenReady().then(() => {
  app.setName('Jewshi');
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
