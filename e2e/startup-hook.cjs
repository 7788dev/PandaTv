// Read-only startup interruption test hook; never included in the application.
const { app, session, dialog } = require('electron');
dialog.showErrorBox = (title, message) => console.error('[captured-native-error]', title, message);
app.whenReady().then(() => {
  let delayed = false;
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['file://*/*.css'] }, (_details, callback) => {
    if (delayed) callback({});
    else { delayed = true; setTimeout(() => callback({}), 1500); }
  });
});
