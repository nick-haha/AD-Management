(() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ease = 'cubic-bezier(.16, 1, .3, 1)';

  requestAnimationFrame(() => {
    requestAnimationFrame(() => document.documentElement.classList.add('ujoy-ready'));
  });

  if (reduced || !Element.prototype.animate) return;

  const reveal = (element, delay = 0, distance = 18) => {
    if (!element || element.dataset.ujRevealed) return;
    element.dataset.ujRevealed = 'true';
    element.animate(
      [
        { opacity: 0, transform: `translate3d(0, ${distance}px, 0)` },
        { opacity: 1, transform: 'translate3d(0, 0, 0)' }
      ],
      { duration: 720, delay, easing: ease, fill: 'both' }
    );
  };

  document.querySelectorAll('.uj-auth-stage').forEach((stage) => {
    const authRoot = stage.closest('.ss-auth-overlay, .login-page');
    const video = stage.querySelector('.uj-auth-video');
    const syncMedia = () => {
      const visible = authRoot && !authRoot.classList.contains('hidden') && getComputedStyle(authRoot).display !== 'none';
      if (!video) return;
      if (visible) video.play().catch(() => {});
      else video.pause();
    };
    if (authRoot) {
      new MutationObserver(syncMedia).observe(authRoot, { attributes: true, attributeFilter: ['class', 'style'] });
      syncMedia();
    }
    const items = [
      stage.querySelector('.uj-wordmark'),
      stage.querySelector('.uj-serial'),
      stage.querySelector('h1'),
      stage.querySelector('.uj-stage-copy p'),
      ...stage.querySelectorAll('.uj-track-step'),
      stage.querySelector('.uj-stage-foot')
    ];
    items.forEach((item, index) => reveal(item, 90 + index * 90, index < 4 ? 22 : 10));

    const steps = [...stage.querySelectorAll('.uj-track-step')];
    let activeIndex = 0;
    if (steps.length > 1) {
      const advance = () => {
        if (document.hidden || (authRoot && (authRoot.classList.contains('hidden') || getComputedStyle(authRoot).display === 'none'))) return;
        steps[activeIndex].classList.remove('is-active');
        activeIndex = (activeIndex + 1) % steps.length;
        steps[activeIndex].classList.add('is-active');
        steps[activeIndex].querySelector('b')?.animate(
          [{ transform: 'scale(.72)', opacity: .3 }, { transform: 'scale(1.06)', opacity: 1 }],
          { duration: 460, easing: ease }
        );
      };
      window.setInterval(advance, 2600);
    }
  });

  document.querySelectorAll('.uj-auth-panel').forEach((panel) => {
    panel.animate(
      [{ opacity: 0, clipPath: 'inset(0 0 10% 0 round 24px)' }, { opacity: 1, clipPath: 'inset(0 round 24px)' }],
      { duration: 900, delay: 100, easing: ease, fill: 'both' }
    );
  });

  const animateChildren = (root) => {
    if (!(root instanceof Element)) return;
    const nodes = root.matches('.ss-card,.result-item,.user-table tbody tr,.task-card,.log-row')
      ? [root]
      : [...root.querySelectorAll('.ss-card,.result-item,.user-table tbody tr,.task-card,.log-row')];
    nodes.slice(0, 16).forEach((node, index) => reveal(node, Math.min(index * 42, 260), 12));
  };

  ['results', 'adminResult', 'logsResult', 'tasksResult'].forEach((id) => {
    const root = document.getElementById(id);
    if (!root) return;
    animateChildren(root);
    new MutationObserver((mutations) => {
      mutations.forEach((mutation) => mutation.addedNodes.forEach(animateChildren));
    }).observe(root, { childList: true, subtree: true });
  });

  document.addEventListener('click', (event) => {
    const nav = event.target.closest('.sidebar-item, .detail-tab');
    if (nav) {
      nav.animate(
        [{ transform: 'scale(.97)' }, { transform: 'scale(1)' }],
        { duration: 360, easing: ease }
      );
    }
    const button = event.target.closest('button, .ss-btn, .btn');
    if (button) {
      button.animate(
        [{ transform: 'scale(.985)' }, { transform: 'scale(1)' }],
        { duration: 260, easing: ease }
      );
    }
  });

  const panels = [...document.querySelectorAll('.tab-panel, .detail-tab-content')];
  if (panels.length) {
    new MutationObserver((mutations) => {
      mutations.forEach(({ target, attributeName }) => {
        if (attributeName !== 'class' || !target.classList.contains('active')) return;
        target.animate(
          [
            { opacity: 0, transform: 'translate3d(0,10px,0)', clipPath: 'inset(0 0 8% 0 round 14px)' },
            { opacity: 1, transform: 'translate3d(0,0,0)', clipPath: 'inset(0 round 14px)' }
          ],
          { duration: 520, easing: ease }
        );
      });
    }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
  }
})();
