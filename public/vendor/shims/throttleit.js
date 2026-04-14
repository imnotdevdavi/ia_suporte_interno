export default function throttle(fn, wait) {
  var callback = typeof fn === 'function' ? fn : function () {};
  var delay = typeof wait === 'number' && wait > 0 ? wait : 100;
  var lastCallAt = 0;
  var timeoutId = null;
  var trailingArgs = null;
  var trailingContext = null;

  function invoke(context, args) {
    lastCallAt = Date.now();
    callback.apply(context, args);
  }

  return function throttled() {
    var now = Date.now();
    var remaining = delay - (now - lastCallAt);
    var args = arguments;
    var context = this;

    if (lastCallAt === 0 || remaining <= 0) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      trailingArgs = null;
      trailingContext = null;
      invoke(context, args);
      return;
    }

    trailingArgs = args;
    trailingContext = context;

    if (!timeoutId) {
      timeoutId = setTimeout(function () {
        timeoutId = null;
        if (!trailingArgs) return;
        invoke(trailingContext, trailingArgs);
        trailingArgs = null;
        trailingContext = null;
      }, remaining);
    }
  };
}
