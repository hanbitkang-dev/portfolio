/* "Demo" pill: tells viewers the data is synthetic and lets them reset what they changed. */
(function () {
  var el = document.createElement('div');
  el.className = 'demo-badge';
  el.innerHTML = '<b>DEMO</b><span class="demo-badge__text">Synthetic data · changes stay in this browser</span>' +
    '<button type="button" title="Restore the original demo data">Reset</button><a href="../" title="Back to the portfolio">Portfolio</a>';
  el.querySelector('button').addEventListener('click', function () {
    if (window.GasDemo) window.GasDemo.reset(); else location.reload();
  });
  document.body.appendChild(el);
})();
