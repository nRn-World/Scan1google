/**
 * Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// If the loader is already loaded, just stop.
if (!self.define) {
  let registry = {};

  // Used for `eval` and `importScripts` where we can't get script URL by other means.
  // In both cases, it's safe to use a global var because those functions are synchronous.
  let nextDefineUri;

  const singleRequire = (uri, parentUri) => {
    uri = new URL(uri + ".js", parentUri).href;
    return registry[uri] || (
      
        new Promise(resolve => {
          if ("document" in self) {
            const script = document.createElement("script");
            script.src = uri;
            script.onload = resolve;
            document.head.appendChild(script);
          } else {
            nextDefineUri = uri;
            importScripts(uri);
            resolve();
          }
        })
      
      .then(() => {
        let promise = registry[uri];
        if (!promise) {
          throw new Error(`Module ${uri} didn’t register its module`);
        }
        return promise;
      })
    );
  };

  self.define = (depsNames, factory) => {
    const uri = nextDefineUri || ("document" in self ? document.currentScript.src : "") || location.href;
    if (registry[uri]) {
      // Module is already loading or loaded.
      return;
    }
    let exports = {};
    const require = depUri => singleRequire(depUri, uri);
    const specialDeps = {
      module: { uri },
      exports,
      require
    };
    registry[uri] = Promise.all(depsNames.map(
      depName => specialDeps[depName] || require(depName)
    )).then(deps => {
      factory(...deps);
      return exports;
    });
  };
}
define(['./workbox-7e5eb42b'], (function (workbox) { 'use strict';

  self.skipWaiting();
  workbox.clientsClaim();
  /**
   * The precacheAndRoute() method efficiently caches and responds to
   * requests for URLs in the manifest.
   * See https://goo.gl/S9QRab
   */
  workbox.precacheAndRoute([{
    "url": "registerSW.js",
    "revision": "1872c500de691dce40960bb85481de07"
  }, {
    "url": "pwa-maskable-512x512.png",
    "revision": "dd15e621493111ee366b9589581dada9"
  }, {
    "url": "pwa-512x512.png",
    "revision": "d98a9f26b21994432a8643181611ca1e"
  }, {
    "url": "pwa-192x192.png",
    "revision": "ac2febce96a16803bb87cc8496bd8cb7"
  }, {
    "url": "index.html",
    "revision": "68db3a7b311e8b9acd32c82927ba2560"
  }, {
    "url": "icon.svg",
    "revision": "31a8294d72cbf91906f7224fbb275fb4"
  }, {
    "url": "apple-touch-icon.png",
    "revision": "04b972ccdebb13b2c453ab12db1f6b0f"
  }, {
    "url": "assets/index-Cqa12BiK.css",
    "revision": null
  }, {
    "url": "assets/index-CfSx5YjR.js",
    "revision": null
  }, {
    "url": "apple-touch-icon.png",
    "revision": "04b972ccdebb13b2c453ab12db1f6b0f"
  }, {
    "url": "icon.svg",
    "revision": "31a8294d72cbf91906f7224fbb275fb4"
  }, {
    "url": "pwa-192x192.png",
    "revision": "ac2febce96a16803bb87cc8496bd8cb7"
  }, {
    "url": "pwa-512x512.png",
    "revision": "d98a9f26b21994432a8643181611ca1e"
  }, {
    "url": "pwa-maskable-512x512.png",
    "revision": "dd15e621493111ee366b9589581dada9"
  }, {
    "url": "manifest.webmanifest",
    "revision": "767ac2911e8aee404b8e46256d969d35"
  }], {});
  workbox.cleanupOutdatedCaches();
  workbox.registerRoute(new workbox.NavigationRoute(workbox.createHandlerBoundToURL("index.html"), {
    denylist: [/^\/api\//]
  }));

}));
