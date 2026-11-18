/* Update handshake: old pages need one automatic transition to the prompt UI.
 * Any content change MUST rename this file (-v2, ...): updateViaCache 'imports'
 * permits the browser to reuse an imported script from its HTTP cache.
 */
(function () {
  // The versioned build import runs again on restart, preserving worker identity.
  self.addEventListener('message', function (event) {
    if (event.data && event.data.type === 'MMR_VERSION' && event.ports[0]) {
      var version = self.__MMR_BUILD_VERSION;
      event.ports[0].postMessage({ version: typeof version === 'string' && /^\d+(\.\d+)+$/.test(version) ? version : null });
    }
    if (event.data && event.data.type === 'MMR_UPDATE_PROTOCOL' && event.ports[0]) {
      event.ports[0].postMessage({ protocol: 1 });
    }
    if (event.data && event.data.type === 'MMR_COUNT_WINDOWS' && event.ports[0]) {
      event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
        var scope = self.registration.scope;
        var windows = clients.filter(function (client) { return client.url.indexOf(scope) === 0; }).length;
        event.ports[0].postMessage({ windows: windows });
      }));
    }
  });

  self.addEventListener('install', function (event) {
    var active = self.registration.active;
    if (!active) return;
    event.waitUntil(new Promise(function (resolve) {
      var channel;
      var finished = false;
      var timeout;
      function finish(supported) {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (channel) {
          channel.port1.close();
          channel.port2.close();
        }
        resolve(supported ? undefined : self.skipWaiting());
      }
      timeout = setTimeout(function () { finish(false); }, 10000);
      try {
        channel = new MessageChannel();
        channel.port1.onmessage = function (reply) {
          finish(!!reply.data && typeof reply.data.protocol === 'number' && reply.data.protocol >= 1);
        };
        active.postMessage({ type: 'MMR_UPDATE_PROTOCOL' }, [channel.port2]);
      } catch (_) {
        finish(false);
      }
    }));
  });
}());
