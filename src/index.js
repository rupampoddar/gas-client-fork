import { nanoid } from 'nanoid';

/**
 * Util that returns true if allowedDevelopmentDomains matches origin
 * @param {string|function} allowedDevelopmentDomains either a string of space-separated allowed subdomains or a function that accepts the origin as an argument and returns true if permitted
 * @param {string} origin the target origin subdomain to compare against
 */
const checkAllowList = (allowedDevelopmentDomains, origin) => {
  if (typeof allowedDevelopmentDomains === 'string') {
    return allowedDevelopmentDomains
      .split(' ')
      .some((permittedOrigin) => permittedOrigin === origin);
  }
  if (typeof allowedDevelopmentDomains === 'function') {
    return allowedDevelopmentDomains(origin) === true;
  }
  return false;
};

export default class Server {
  /**
   * Accepts a single `config` object
   * @param {object} [config] An optional config object for use in development.
   * @param {string|function} [config.allowedDevelopmentDomains] An optional config to specify which domains are permitted for receiving communication from a parent window. This is a security setting, and if not specified, will block functionality in development. Will accept either a space-separated string of allowed subdomains, e.g. `https://localhost:3000 http://localhost:3000` (notice no trailing slash); or a function that takes in the requesting origin should return `true` to allow communication, e.g. `(origin) => /localhost:\d+$/.test(origin)`
   * @param {string} [config.parentTargetOrigin] An optional config to specify which parent window domain this client can send communication to. Defaults to own domain for backward compatibility with Google Apps Script Webpack Dev Server development tool (domain where the client is running, e.g. localhost). Can be '*' to allow all parent domains.
   */
  constructor(config = {}) {
    // skip the reserved names: https://developers.google.com/apps-script/guides/html/reference/run
    const ignoredFunctionNames = [
      'withFailureHandler',
      'withLogger',
      'withSuccessHandler',
      'withUserObject',
    ];

    this.serverFunctions = {};

    try {
      // get the names of all of our publicly accessible server functions
      const functionNames = Object.keys(google.script.run).filter(
        // filter out the reserved names -- we don't want those
        (functionName) => !ignoredFunctionNames.includes(functionName)
      );

      // attach Promise-based functions to the serverFunctions property
      functionNames.forEach((functionName) => {
        this.serverFunctions[functionName] = (...args) =>
          new Promise((resolve, reject) => {
            google.script.run
              .withSuccessHandler(resolve)
              .withFailureHandler(reject)
              [functionName](...args);
          });
      });
    } catch (err) {
      if (typeof google === 'undefined') {
        // we're in the dev server iframe

        // we'll store and access the resolve/reject functions here by id
        window.gasStore = {};

        // the parent (also an iframe) url.
        // this domain should be restricted to googleusercontent.com,
        // but the subdomain is variable supports window.location.origin
        // as default for backward compatibility
        // let targetOrigin = config.parentTargetOrigin || window.location.origin;
        const targetOrigin =
          window.location !== window.parent.location
            ? document.referrer
            : document.location.href;

        // set up the message 'receive' handler
        const receiveMessageHandler = (event) => {
          const { allowedDevelopmentDomains } = config;

          // check the allow list for the receiving origin
          const allowOrigin = checkAllowList(
            allowedDevelopmentDomains,
            event.origin
          );
          if (!allowOrigin) return;

          // we only care about the type: 'RESPONSE' messages here
          if (event.data.type !== 'RESPONSE') return;

          const { response, status, id } = event.data;

          // look up the saved resolve and reject funtions in our global store based
          // on the response id, and call the function depending on the response status
          const { resolve, reject } = window.gasStore[id];

          if (status === 'ERROR') {
            // TODO: return here so resolve doesn't get called on error
            reject(response);
          }
          resolve(response);
        };
        // listen for message event (sent from parent via postMessage)
        window.addEventListener('message', receiveMessageHandler, false);

        // proxy handler
        const handler = {
          get(target, functionName) {
            const id = nanoid();
            const promise = new Promise((resolve, reject) => {
              // store the new Promise's resolve and reject
              window.gasStore[id] = { resolve, reject };
            });
            return (...args) => {
              // https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage
              window.parent.postMessage(
                {
                  type: 'REQUEST',
                  id,
                  functionName,
                  args: [...args],
                },
                targetOrigin
              );
              return promise;
            };
          },
        };
        this.serverFunctions = new Proxy({}, handler);
      }
    }
  }
}
