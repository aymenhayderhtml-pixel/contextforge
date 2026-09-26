/**
 * public/js/shared/toast.js
 * Toast notification overlay.
 */

let toastTimeout = null;

/**
 * Display a temporary toast notification in the bottom right corner.
 * @param {string} message
 * @param {'info'|'success'|'error'|'warn'} [type='info']
 */
export function showToast(message, type = 'info') {
  let toastEl = document.getElementById('cf-toast');
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'cf-toast';
    toastEl.className = 'cf-toast';
    document.body.appendChild(toastEl);
  }

  const icons = {
    info: 'ℹ️',
    success: '✅',
    error: '❌',
    warn: '⚠️'
  };

  toastEl.innerHTML = `<span>${icons[type] || 'ℹ️'}</span> <span>${message}</span>`;
  toastEl.className = `cf-toast show ${type}`;

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toastEl.className = 'cf-toast';
  }, 3200);
}
