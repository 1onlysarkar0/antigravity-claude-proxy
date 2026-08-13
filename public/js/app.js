(function () {
  // Minimal app bootstrap for Antigravity WebUI
  // - Registers any components added to window.Components with Alpine
  // - Starts Alpine when ready

  function registerComponents() {
    if (!window.Components) return;
    try {
      Object.entries(window.Components).forEach(([name, factory]) => {
        if (typeof factory === 'function' && window.Alpine && typeof window.Alpine.data === 'function') {
          try {
            window.Alpine.data(name, factory);
          } catch (e) {
            // swallow registration errors to avoid breaking UI init
            console && console.error && console.error('Failed to register component', name, e);
          }
        }
      });
    } catch (e) {
      console && console.error && console.error('Error registering components', e);
    }
  }

  function initAlpine() {
    if (!window.Alpine) return false;

    // Attach a small helper for debugging if not present
    window.UILogger = window.UILogger || {
      debug: function () {
        if (window.console && console.debug) console.debug.apply(console, arguments);
      },
      info: function () {
        if (window.console && console.info) console.info.apply(console, arguments);
      }
    };

    registerComponents();

    try {
      // Start Alpine (idempotent)
      if (typeof window.Alpine.start === 'function') {
        window.Alpine.start();
      }
      window.UILogger.debug && window.UILogger.debug('Alpine started');
    } catch (e) {
      console && console.error && console.error('Failed to start Alpine', e);
    }

    return true;
  }

  function ready() {
    // Try immediate init; if Alpine not loaded yet, poll briefly
    if (initAlpine()) return;

    var tries = 0;
    var t = setInterval(function () {
      if (initAlpine() || ++tries > 100) {
        clearInterval(t);
      }
    }, 50);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready);
  } else {
    ready();
  }
})();
