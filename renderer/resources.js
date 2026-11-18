'use strict';

// Info & Resources: the help is written into the page. The two help buttons open rooms in
// the Showdown client, so they need it running and the user signed in for a ticket.
(() => {
  const status = document.getElementById('help-status');
  for (const button of document.querySelectorAll('[data-room]')) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      let ok = false;
      try {
        ok = (await window.desktop.showdown('join', { room: button.dataset.room })) === true;
      } catch {}
      button.disabled = false;
      if (ok) {
        location.href = 'play.html';
        return;
      }
      status.textContent = "Showdown isn't connected yet. Try again in a moment.";
      status.hidden = false;
    });
  }

  // The contents list follows the section being read.
  const links = [...document.querySelectorAll('.res-toc a')];
  const content = document.querySelector('.content');
  const sections = links.map((a) => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  function mark() {
    const top = content.getBoundingClientRect().top + 80;
    let at = 0;
    sections.forEach((section, i) => { if (section.getBoundingClientRect().top <= top) at = i; });
    if (content.scrollTop + content.clientHeight >= content.scrollHeight - 4) at = sections.length - 1;
    links.forEach((a, i) => {
      if (i === at) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });
  }
  content.addEventListener('scroll', mark, { passive: true });
  for (const a of links) {
    a.addEventListener('click', (event) => {
      event.preventDefault();
      const target = document.querySelector(a.getAttribute('href'));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  mark();
})();
