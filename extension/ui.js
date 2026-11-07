'use strict';
// Shared range styling and bounded, keyboard-accessible tooltips for both surfaces.
(() => {
  const tooltip = document.createElement('div');
  tooltip.id = 'uiTooltip'; tooltip.className = 'ui-tooltip'; tooltip.role = 'tooltip'; tooltip.hidden = true;
  document.body.append(tooltip);
  let owner = null, originalTitle = '', timer;
  function hide() {
    clearTimeout(timer); tooltip.hidden = true;
    if (owner) {
      if (!owner.hasAttribute('title')) owner.setAttribute('title', originalTitle);
      const ids = (owner.getAttribute('aria-describedby') || '').split(' ').filter(id => id && id !== tooltip.id);
      if (ids.length) owner.setAttribute('aria-describedby', ids.join(' ')); else owner.removeAttribute('aria-describedby');
    }
    owner = null;
  }
  function show(element) {
    if (owner === element) return;
    hide();
    if (!element?.title) return;
    owner = element; originalTitle = element.title; element.removeAttribute('title');
    timer = setTimeout(() => {
      if (!owner?.isConnected) return hide();
      tooltip.textContent = originalTitle; tooltip.hidden = false;
      const target = owner.getBoundingClientRect(), box = tooltip.getBoundingClientRect();
      const left = Math.max(8, Math.min(innerWidth - box.width - 8, target.x + target.width / 2 - box.width / 2));
      const above = target.y >= box.height + 12;
      tooltip.dataset.placement = above ? 'above' : 'below';
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${Math.max(8, Math.min(innerHeight - box.height - 8, above ? target.y - box.height - 8 : target.bottom + 8))}px`;
      tooltip.style.setProperty('--arrow-x', `${Math.max(7, Math.min(box.width - 7, target.x + target.width / 2 - left))}px`);
      const ids = new Set((owner.getAttribute('aria-describedby') || '').split(' ').filter(Boolean)); ids.add(tooltip.id);
      owner.setAttribute('aria-describedby', [...ids].join(' '));
    }, 350);
  }
  const targetFor = target => target instanceof Element ? target.closest('button[title],input[title],select[title],a[title]') : null;
  document.addEventListener('pointerover', event => { const target = targetFor(event.target); if (target) show(target); });
  document.addEventListener('pointerout', event => { if (owner?.contains(event.target) && !owner.contains(event.relatedTarget)) hide(); });
  document.addEventListener('focusin', event => { const target = targetFor(event.target); if (target) show(target); });
  document.addEventListener('focusout', event => { if (event.target === owner) hide(); });
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  document.addEventListener('scroll', hide, true); window.addEventListener('resize', hide);
  function rangeFill(input) {
    const min = Number(input.min) || 0, max = Number(input.max) || 100;
    input.style.setProperty('--range-fill', `${Math.max(0, Math.min(100, (Number(input.value) - min) / (max - min || 1) * 100))}%`);
  }
  document.querySelectorAll('input[type=range]').forEach(rangeFill);
  document.addEventListener('input', event => { if (event.target.matches('input[type=range]')) rangeFill(event.target); });
})();
