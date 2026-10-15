const fileInput = document.querySelector('#reel-file'), player = document.querySelector('[data-reel-video]'), placeholder = document.querySelector('[data-reel-empty]'), clear = document.querySelector('[data-reel-clear]'), status = document.querySelector('[data-reel-status]');
let currentURL = null;
function reset() { player.pause(); player.removeAttribute('src'); player.load(); if (currentURL) URL.revokeObjectURL(currentURL); currentURL = null; player.hidden = true; placeholder.hidden = false; clear.disabled = true; fileInput.value = ''; }
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]; if (!file) return;
  if (!['video/mp4', 'video/webm'].includes(file.type) || file.size > 500 * 1024 * 1024) { status.textContent = 'Choose an MP4 or WebM video up to 500 MB.'; fileInput.value = ''; return; }
  reset(); currentURL = URL.createObjectURL(file); player.src = currentURL; player.hidden = false; placeholder.hidden = true; clear.disabled = false;
  status.textContent = `${file.name} · local session preview. Nothing is uploaded.`;
});
player.addEventListener('error', () => { if (currentURL) status.textContent = 'This browser cannot play the selected video. Try a supported MP4 or WebM encoding.'; });
clear.addEventListener('click', () => { reset(); status.textContent = 'Local video cleared.'; });
window.addEventListener('pagehide', () => { reset(); status.textContent = 'Choose a local video to review it for this session.'; });
