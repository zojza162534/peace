// Keeps the service worker alive by pinging it every 20 seconds
setInterval(() => {
  chrome.runtime.sendMessage({ type: 'keepAlive' }).catch(() => {});
}, 20000);
