'use strict';
(() => {
  const input = document.getElementById('t');
  input.focus();
  document.getElementById('f').addEventListener('submit', (e) => {
    e.preventDefault();
    window.intentApi.submit(input.value);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.intentApi.cancel();
  });
})();
