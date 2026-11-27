import { BROWSER_REQUIREMENTS, supportsBrowserRuntime } from './services/browserSupport.js';

if (supportsBrowserRuntime()) {
  void import('./main.js');
} else {
  const message = document.createElement('p');
  message.textContent = BROWSER_REQUIREMENTS;
  message.setAttribute('role', 'alert');
  message.style.cssText = 'max-width:36em;margin:48px auto;padding:20px 24px;'
    + 'background:#f6faff;color:#03254f;font-family:Arial,sans-serif;line-height:1.5';
  document.getElementById('root')?.appendChild(message);
}
