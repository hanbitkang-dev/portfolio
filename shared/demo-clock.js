/* Demo clock: the synthetic data is dated around one day, so the page runs as if it were
   that day (time still moves forward from page load). Without this, "this week", overdue
   and stalled views would drift as real time passes. Set window.DEMO_TODAY before loading. */
(function () {
  var RealDate = Date;
  var start = new RealDate((window.DEMO_TODAY || '2026-10-29') + 'T10:00:00+13:00').getTime();
  var offset = start - RealDate.now();
  function DemoDate() {
    var a = [].slice.call(arguments);
    if (!(this instanceof DemoDate)) return new RealDate(RealDate.now() + offset).toString();
    if (!a.length) return new RealDate(RealDate.now() + offset);
    return new (Function.prototype.bind.apply(RealDate, [null].concat(a)))();
  }
  DemoDate.prototype = RealDate.prototype;
  DemoDate.now = function () { return RealDate.now() + offset; };
  DemoDate.parse = RealDate.parse;
  DemoDate.UTC = RealDate.UTC;
  window.Date = DemoDate;
})();
