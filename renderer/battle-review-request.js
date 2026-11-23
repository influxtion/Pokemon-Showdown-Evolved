'use strict';

// Only click handlers call this. Opening a page or painting an end-of-battle prompt is free.
let leavingBattleReviewSource = false;
window.addEventListener('pagehide', () => { leavingBattleReviewSource = true; });

// A historical ended room still has a review button. Offer the review once only after a
// live player battle finishes. Moving through launcher pages retains that transition.
window.BattleReviewOffer = class BattleReviewOffer {
  constructor(kind, fallback, openReview) {
    this.key = 'battleReview.offer.' + kind;
    this.kind = kind;
    this.fallback = fallback;
    this.panel = document.getElementById('review-offer');
    this.room = '';
    this.states = new Map();
    try {
      const saved = JSON.parse(sessionStorage.getItem(this.key));
      if (Array.isArray(saved)) this.states = new Map(saved.slice(-40));
    } catch {}
    document.getElementById('offer-dismiss').addEventListener('click', () => {
      this.dismiss();
      openReview.focus();
    });
    document.getElementById('offer-open').addEventListener('click', () => { this.dismiss(); openReview.click(); });
  }
  remember(id, phase) {
    if (this.states.get(id) === phase) return;
    this.states.delete(id);
    this.states.set(id, phase);
    if (this.states.size > 40) this.states.delete(this.states.keys().next().value);
    try { sessionStorage.setItem(this.key, JSON.stringify([...this.states])); } catch {}
  }
  dismiss() {
    this.panel.hidden = true;
    this.fallback.hidden = false;
  }
  update(roomId, ended, eligible = true) {
    const id = (roomId || '').replace(/-[a-z0-9]+pw$/, '');
    if (!id || !ended || id !== this.room || !eligible) this.panel.hidden = true;
    this.room = id;
    if (id) {
      const previous = this.states.get(id);
      if (!ended && (previous !== 'offered' || this.kind === 'practice')) this.remember(id, 'live');
      if (ended && previous !== 'offered') {
        this.remember(id, 'offered');
        this.panel.hidden = previous !== 'live' || !eligible;
      }
    }
    this.fallback.hidden = !id || !ended || !this.panel.hidden;
  }
};

window.requestBattleReview = async function (button, source, feedback, complete, stillSelected) {
  if (!source || button.disabled || button.getAttribute('aria-busy') === 'true') return;
  button.setAttribute('aria-busy', 'true');
  button.disabled = true;
  feedback.hidden = false;
  feedback.textContent = source.kind === 'url' || source.kind === 'note'
    ? 'Fetching the replay from Showdown…' : 'Reviewing the battle…';
  try {
    const result = await window.desktop.reviewBattle(source);
    if (stillSelected && !await stillSelected()) return;
    if (leavingBattleReviewSource) return;
    if (result?.cancelled) feedback.textContent = 'Review cancelled.';
    else if (!result?.ok) feedback.textContent = result?.error || 'Could not review this battle.';
    else if (complete) await complete();
    else location.href = 'battle-review.html';
  } catch {
    feedback.textContent = 'Could not open the battle review. Try again.';
  } finally {
    button.removeAttribute('aria-busy');
    button.disabled = false;
  }
};
